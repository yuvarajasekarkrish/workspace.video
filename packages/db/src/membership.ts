import { prisma } from "./index";
import { Prisma } from "@prisma/client";

/** Phase 11 Part C: counts every transient-retry attempt actually taken, so a
 *  future load-test run can attribute join-latency tail (or not) to this
 *  path's 300/600/900/1200ms backoff instead of guessing from timing alone.
 *  Exported read-only; nothing resets it — server.ts reads it as a
 *  monotonically increasing counter, same treatment as the lease-outcome
 *  counts in roomManager.ts. */
export const transientRetryStats = { attempts: 0 };

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
 *  always did) — so a sub-second retry budget was not enough headroom.
 *
 *  Exported so other repository modules (e.g. objects.ts) can wrap their
 *  own Prisma calls in the same retry policy rather than re-rolling it. */
export async function withTransientRetry<T>(fn: () => Promise<T>, attempts = 5, delayMs = 300): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isTransient = err instanceof Prisma.PrismaClientInitializationError || (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P1001");
      if (!isTransient || attempt === attempts - 1) throw err;
      transientRetryStats.attempts++;
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
): Promise<{ workspaceId: string; config: unknown }> {
  // One round trip, not two: the membership check is expressed as a nested
  // filter on the same query that reads the room, rather than a second
  // findUnique chained on the first query's result. Phase 11: this handler
  // is on the join_room hot path, and at load every serialized round trip
  // queues separately against the connection pool.
  const room = await withTransientRetry(() =>
    prisma.room.findUnique({
      where: { id: roomId },
      select: {
        workspaceId: true,
        config: true,
        workspace: { select: { members: { where: { userId }, select: { userId: true }, take: 1 } } },
      },
    }),
  );
  if (!room) {
    throw new Error("Room not found.");
  }
  if (room.workspace.members.length === 0) {
    throw new Error("User is not a member of this room's workspace.");
  }

  // `config` is included alongside workspaceId purely as a convenience for
  // callers that need both from one round trip (e.g. the realtime server's
  // join_room, which resolves the room's layout right after this call) —
  // existing callers that only destructure `{ workspaceId }` are unaffected.
  return { workspaceId: room.workspaceId, config: room.config };
}

/**
 * The membership half of assertRoomMembership on its own, for a caller that
 * already knows `workspaceId` (Phase 11: the realtime server's join_room,
 * once its RoomManager already owns the room — the room lookup that
 * resolves workspaceId is then redundant work, since the owning instance
 * cached it on first join). Every join still calls this: a room's
 * workspaceId never changes, but membership is per-user and must always be
 * re-checked.
 */
export async function assertWorkspaceMembership(userId: string, workspaceId: string): Promise<void> {
  const membership = await withTransientRetry(() =>
    prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId } },
      select: { userId: true },
    }),
  );
  if (!membership) {
    throw new Error("User is not a member of this room's workspace.");
  }
}
