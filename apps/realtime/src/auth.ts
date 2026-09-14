import jwt from "jsonwebtoken";
import { prisma } from "@cosmos/db";

export interface AuthenticatedUser {
  userId: string;
  email: string;
}

/**
 * Verifies the session token a client presents at Socket.IO handshake.
 * Matches Auth.js/NextAuth's JWT session strategy (HS256, signed with
 * AUTH_SECRET) — the realtime server never trusts a client-supplied user id,
 * only what falls out of a token it can verify itself.
 */
export function verifySessionToken(token: string, secret: string): AuthenticatedUser {
  const payload = jwt.verify(token, secret) as jwt.JwtPayload;
  const userId = payload.sub;
  const email = payload.email as string | undefined;
  if (!userId || !email) {
    throw new Error("Session token missing required claims (sub, email).");
  }
  return { userId, email };
}

/**
 * Confirms the authenticated user is actually a member of the workspace that
 * owns `roomId`, and returns the room's workspace id. Called on `join_room` —
 * roomId itself is client-supplied and must never be trusted for authorization
 * without this check.
 */
export async function assertRoomMembership(
  userId: string,
  roomId: string,
): Promise<{ workspaceId: string }> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    select: { workspaceId: true },
  });
  if (!room) {
    throw new Error("Room not found.");
  }

  const membership = await prisma.workspaceMember.findUnique({
    where: { workspaceId_userId: { workspaceId: room.workspaceId, userId } },
    select: { userId: true },
  });
  if (!membership) {
    throw new Error("User is not a member of this room's workspace.");
  }

  return { workspaceId: room.workspaceId };
}
