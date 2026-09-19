import jwt from "jsonwebtoken";

export { assertRoomMembership, assertWorkspaceMembership } from "@cosmos/db";

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
