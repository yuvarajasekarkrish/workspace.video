import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { magicLink } from "better-auth/plugins/magic-link";
import type { PrismaClient } from "@workspace-video/db";
import { withTimeout, type MagicLinkMailer } from "./mailer";

export interface AuthDeps {
  prisma: PrismaClient;
  mailer: MagicLinkMailer;
  /** Signs and encrypts Better Auth's own cookies. This is AUTH_SECRET. */
  secret: string;
  /** Public address of this app, e.g. https://www.workspace.video. Links are only
   *  ever built for this origin. */
  baseURL: string;
  /** Requests per address to the request-a-link endpoint. */
  rateLimit?: { enabled: boolean; window: number; max: number };
  /** How long to wait for the email provider before failing the request. */
  mailTimeoutMs?: number;
}

const SEVEN_DAYS = 60 * 60 * 24 * 7;
const ONE_DAY = 60 * 60 * 24;
const LINK_LIFETIME_SECONDS = 15 * 60;
const DEFAULT_MAIL_TIMEOUT_MS = 10_000;

/**
 * The single place Better Auth is configured.
 *
 * Passwordless: a person enters an email, receives a one-time link, and the link
 * signs them in (creating the account on first use). Links are single use, expire
 * after 15 minutes, and are stored hashed. Sessions are server-side rows, so they
 * can be revoked, and the cookie is httpOnly, same-site lax, and secure over https.
 *
 * Do not expose `auth.handler` directly: route requests through handleAuthRequest,
 * which adds the redirect, rate-limit and error rules Better Auth does not apply.
 */
export function createAuth(deps: AuthDeps) {
  const mailer = withTimeout(deps.mailer, deps.mailTimeoutMs ?? DEFAULT_MAIL_TIMEOUT_MS);
  return betterAuth({
    appName: "workspace.video",
    baseURL: deps.baseURL,
    secret: deps.secret,
    database: prismaAdapter(deps.prisma, { provider: "postgresql" }),
    session: { expiresIn: SEVEN_DAYS, updateAge: ONE_DAY },
    advanced: { useSecureCookies: deps.baseURL.startsWith("https://") },
    rateLimit: {
      enabled: deps.rateLimit?.enabled ?? true,
      window: deps.rateLimit?.window ?? 60,
      max: deps.rateLimit?.max ?? 100,
      customRules: {
        "/sign-in/magic-link": { window: 60, max: deps.rateLimit?.max ?? 5 },
      },
    },
    plugins: [
      magicLink({
        expiresIn: LINK_LIFETIME_SECONDS,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          await mailer.sendMagicLink({ to: email, url });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
