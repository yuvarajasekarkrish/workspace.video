import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { prisma } from "@workspace-video/db";
import { createAuth } from "@/lib/auth/auth";
import { AUTH_SECRET, REAL_ENV, setEnv } from "./testEnv";

/** A real Better Auth instance on the real database with an in-memory mailer,
 *  for tests that need a genuine signed-in session. Every account it creates
 *  ends in this test file's own domain and is removed by `removeTestUsers`.
 *
 *  The domain is unique per test file (each file loads this module fresh), because
 *  files run in parallel against one database: a shared domain let one file's
 *  cleanup delete users another file was still using. */
export const TEST_DOMAIN = `@it-${randomUUID().replace(/-/g, "").slice(0, 10)}.invalid`;
export const TEST_BASE_URL = "https://www.workspace.video";

export interface TestAuth {
  auth: ReturnType<typeof createAuth>;
  sent: { to: string; url: string }[];
  baseURL: string;
}

export function makeTestAuth(baseURL = TEST_BASE_URL, secret = AUTH_SECRET): TestAuth {
  const sent: TestAuth["sent"] = [];
  const auth = createAuth({
    prisma,
    secret,
    baseURL,
    rateLimit: { enabled: false, window: 60, max: 5 },
    mailer: {
      async sendMagicLink(message) {
        sent.push(message);
      },
    },
  });
  return { auth, sent, baseURL };
}

let counter = 0;
export const uniqueTestEmail = (label = "u") => `${label}-${Date.now()}-${counter++}${TEST_DOMAIN}`;

/** Requests a link, opens it, and returns the `cookie` request header a browser would then send. */
export async function signIn(t: TestAuth, email: string): Promise<string> {
  await t.auth.handler(
    new Request(`${t.baseURL}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: t.baseURL },
      body: JSON.stringify({ email, callbackURL: "/" }),
    }),
  );
  const link = t.sent.at(-1)?.url;
  if (!link) throw new Error("no sign-in link was sent");
  const opened = await t.auth.handler(new Request(link));
  const cookie = opened.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  if (!cookie) throw new Error("opening the link set no session cookie");
  return cookie;
}

export async function removeTestUsers(): Promise<void> {
  await prisma.user.deleteMany({ where: { email: { endsWith: TEST_DOMAIN } } });
  await prisma.verification.deleteMany({ where: { value: { contains: TEST_DOMAIN } } });
}

/** Production-like environment, then a fresh module registry, then the mocked
 *  `@/lib/auth` (see `authMockFactory`) to hand back its test instance. */
export async function bootstrap(): Promise<{ t: TestAuth; useCookie: (cookie?: string) => Promise<void> }> {
  setEnv({ ...REAL_ENV, NODE_ENV: "production" });
  vi.resetModules();
  const { __test } = (await import("@/lib/auth")) as unknown as { __test: TestAuth };
  const { headers } = await import("next/headers");
  return {
    t: __test,
    useCookie: async (cookie) => {
      vi.mocked(headers).mockResolvedValue(new Headers(cookie ? { cookie } : {}) as never);
    },
  };
}

/** Factory for `vi.mock("@/lib/auth", authMockFactory)`: getAuth returns a test instance. */
export async function authMockFactory() {
  const t = makeTestAuth();
  return { getAuth: () => t.auth, emailLimiter: undefined, __test: t };
}
