import { prisma } from "./index";
import { Prisma } from "@prisma/client";

/** Retries a Prisma call a couple of times, but only for a transient
 *  connection failure (P1001 "Can't reach database server") — never for a
 *  genuine query result like a missing row, which must fail immediately.
 *  A brief connection drop between this process and Postgres (a container
 *  networking blip, a restart) is recoverable; masking a real "not found"
 *  behind a retry would not be.
 *
 *  Budget: 5 attempts with backoff up to a few seconds. Verified during
 *  Milestone 1 development that a GPU-accelerated browser doing real WebGL
 *  rendering (the Pixi canvas) concurrently with Docker Desktop's Postgres
 *  container can stall the container networking path for multiple seconds
 *  on a resource-constrained host — reproduced consistently (curl alone
 *  never triggered it; a live Chromium instance rendering the canvas
 *  always did) — so a sub-second retry budget was not enough headroom. */
async function withTransientRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 300): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isTransient = err instanceof Prisma.PrismaClientInitializationError || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P1001");
      if (!isTransient || attempt === attempts - 1) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs * (attempt + 1)));
    }
  }
  throw lastError;
}

/**
 * Confirms a user is actually a member of the workspace that owns `roomId`,
 * and returns the room's workspace id. This is the single shared
 * authorization rule for "can this user act on this room" — both the
 * realtime server (on `join_room`) and the Next.js API route that resolves a
 * room's realtime endpoint (which participates in claiming the room's
 * ownership lease) call this same function rather than each re-implementing
 * their own membership check. `roomId` is always client-supplied and must
 * never be trusted for authorization without this.
 */
export async function assertRoomMembership(
  userId: string,
  roomId: string,
): Promise<{ workspaceId: string }> {
  const room = await withTransientRetry(() =>
    prisma.room.findUnique({
      where: { id: roomId },
      select: { workspaceId: true },
    }),
  );
  if (!room) {
    throw new Error("Room not found.");
  }

  const membership = await withTransientRetry(() =>
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: room.workspaceId, userId } },
      select: { userId: true },
    }),
  );
  if (!membership) {
    throw new Error("User is not a member of this room's workspace.");
  }

  return { workspaceId: room.workspaceId };
}
