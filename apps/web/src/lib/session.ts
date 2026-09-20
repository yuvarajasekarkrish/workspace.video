import jwt from "jsonwebtoken";
import { cookies } from "next/headers";
import { env } from "./env";

export const SESSION_COOKIE_NAME = "workspace_video_session";

export interface SessionUser {
  userId: string;
  email: string;
}

/** Signs the long-lived app session cookie (dev sign-in flow only in this
 *  milestone). Uses AUTH_SECRET, which is never used for the realtime token. */
export function signSessionToken(user: SessionUser): string {
  return jwt.sign({ sub: user.userId, email: user.email }, env.authSecret, { expiresIn: "7d" });
}

/** Signs a short-lived token for the Socket.IO handshake. Deliberately
 *  separate from the session cookie: the cookie is httpOnly (unreadable by
 *  client JS, as it should be), but the socket client needs the token value
 *  in JS to pass as `auth.token` — so this is returned in a response body,
 *  not set as a cookie, and kept short-lived to bound the exposure. Because JS
 *  can read it, it is signed with REALTIME_JWT_SECRET, a different secret from
 *  the cookie's, so a leaked socket token is not a valid sign-in cookie. */
export function signRealtimeToken(user: SessionUser): string {
  return jwt.sign({ sub: user.userId, email: user.email }, env.realtimeJwtSecret, { expiresIn: "1h" });
}

export function verifySessionToken(token: string): SessionUser {
  const payload = jwt.verify(token, env.authSecret) as jwt.JwtPayload;
  const userId = payload.sub;
  const email = payload.email as string | undefined;
  if (!userId || !email) {
    throw new Error("Session token missing required claims (sub, email).");
  }
  return { userId, email };
}

/** Reads and verifies the session cookie from the current request context
 *  (route handler or RSC). Returns null rather than throwing when there is
 *  no session or it fails verification — callers decide how to respond. */
export async function getSessionUser(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  try {
    return verifySessionToken(token);
  } catch {
    return null;
  }
}
