import { prisma } from "@workspace-video/db";
import { env } from "../env";
import { createAuth } from "./auth";

/**
 * Development only: returns the Set-Cookie headers of a real Better Auth session
 * for an account that already exists, without an email round trip.
 *
 * It goes through Better Auth's own request-a-link and open-the-link steps (with a
 * mailer that just remembers the link) instead of writing a session row and signing
 * a cookie by hand, so the session is exactly what a real sign-in produces and this
 * file has no knowledge of Better Auth's cookie format. Callers must have checked
 * env.devAuthEnabled; this file does not.
 */
export async function devSignInCookies(email: string): Promise<string[]> {
  let link: string | undefined;
  const auth = createAuth({
    prisma,
    secret: env.authSecret,
    baseURL: env.appUrl,
    rateLimit: { enabled: false, window: 60, max: 5 },
    mailer: {
      async sendMagicLink({ url }) {
        link = url;
      },
    },
  });

  const asked = await auth.handler(
    new Request(`${env.appUrl}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: env.appUrl },
      body: JSON.stringify({ email, callbackURL: "/" }),
    }),
  );
  if (!asked.ok || !link) throw new Error(`dev sign-in: could not create a sign-in link (status ${asked.status})`);

  const opened = await auth.handler(new Request(link));
  const cookies = opened.headers.getSetCookie();
  if (cookies.length === 0) throw new Error("dev sign-in: opening the link did not create a session");
  return cookies;
}
