import "server-only";
import { prisma } from "@workspace-video/db";
import { env } from "../env";
import { createAuth, type Auth } from "./auth";
import { createMailer } from "./mailer";
import { SlidingWindowLimiter } from "./emailLimiter";

let cached: Auth | undefined;

/** The app's Better Auth instance, built on first use so importing this file
 *  (for example while building) does not need the running environment. */
export function getAuth(): Auth {
  cached ??= createAuth({
    prisma,
    secret: env.authSecret,
    baseURL: env.appUrl,
    mailer: createMailer({ nodeEnv: env.nodeEnv }),
  });
  return cached;
}

/** At most 3 sign-in links per email address per 10 minutes. */
export const emailLimiter = new SlidingWindowLimiter({ max: 3, windowMs: 10 * 60_000 });
