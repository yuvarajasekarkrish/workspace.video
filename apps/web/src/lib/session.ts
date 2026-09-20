import jwt from "jsonwebtoken";
import { headers } from "next/headers";
import { getAuth } from "./auth";
import { env } from "./env";

export interface SessionUser {
  userId: string;
  email: string;
}

/** Signs a short-lived token for the Socket.IO handshake. The sign-in session is
 *  an httpOnly cookie that browser JavaScript cannot read, but the socket client
 *  needs a token value in JS to pass as `auth.token`, so this one is returned in
 *  a response body and kept short-lived to bound the exposure. It is signed with
 *  REALTIME_JWT_SECRET, a different secret from the sign-in one, so a leaked
 *  socket token is not a valid sign-in. */
export function signRealtimeToken(user: SessionUser): string {
  return jwt.sign({ sub: user.userId, email: user.email }, env.realtimeJwtSecret, { expiresIn: "1h" });
}

/** The signed-in user of the current request (route handler or server component),
 *  read from the Better Auth session cookie, or null when there is none, it is not
 *  valid, it has expired, or it has been revoked. A database failure is not "signed
 *  out": it throws, so it is seen instead of quietly logging everyone out. */
export async function getSessionUser(): Promise<SessionUser | null> {
  // Read the request headers FIRST: during `next build` this is what tells Next the page
  // is per-request and must not be prerendered. Touching the sign-in setup before it
  // would run production start-up checks (e.g. no email provider) at build time.
  const requestHeaders = await headers();
  const session = await getAuth().api.getSession({ headers: requestHeaders });
  if (!session) return null;
  return { userId: session.user.id, email: session.user.email };
}
