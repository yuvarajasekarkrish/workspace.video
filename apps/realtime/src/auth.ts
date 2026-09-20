import jwt from "jsonwebtoken";

export { assertRoomMembership, assertWorkspaceMembership } from "@workspace-video/db";

export interface AuthenticatedUser {
  userId: string;
  email: string;
}

/**
 * Verifies the short-lived token a client presents at Socket.IO handshake
 * (HS256, signed by the web app with REALTIME_JWT_SECRET, not the sign-in
 * secret) — the realtime server never trusts a client-supplied user id, only
 * what falls out of a token it can verify itself.
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
