// @vitest-environment node
import { describe, it, expect, beforeEach, afterAll, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { AUTH_SECRET, REAL_ENV, setEnv, restoreEnv } from "@/lib/__tests__/helpers/testEnv";
import { makeTestAuth, removeTestUsers, TEST_BASE_URL, TEST_DOMAIN } from "@/lib/__tests__/helpers/testAuth";

/** The real database, with `prisma.user.findUnique` counted so a test can prove
 *  the route never looked anyone up. */
const lookups = vi.hoisted(() => ({ findUnique: undefined as unknown as ReturnType<typeof vi.fn> }));
vi.mock("@workspace-video/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@workspace-video/db")>();
  const findUnique = vi.fn((args: never) => real.prisma.user.findUnique(args));
  lookups.findUnique = findUnique;
  const user = new Proxy(real.prisma.user, { get: (t, p, r) => (p === "findUnique" ? findUnique : Reflect.get(t, p, r)) });
  const prisma = new Proxy(real.prisma, { get: (t, p, r) => (p === "user" ? user : Reflect.get(t, p, r)) });
  return { ...real, prisma };
});
vi.mock("next/headers", () => ({ headers: vi.fn() }));

const SEEDED_EMAIL = `dev-${Date.now()}${TEST_DOMAIN}`;

/** The route reads env.devAuthEnabled at import, so set the environment and import fresh. */
async function loadRoute(env: { NODE_ENV: string; ENABLE_DEV_AUTH?: string }) {
  setEnv({ ...REAL_ENV, ...env });
  vi.resetModules();
  return import("../dev-signin/route");
}

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/auth/dev-signin", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

beforeEach(async () => {
  const { prisma } = await import("@workspace-video/db");
  await prisma.user.upsert({ where: { email: SEEDED_EMAIL }, update: {}, create: { email: SEEDED_EMAIL, name: "Dev User" } });
});

afterEach(() => {
  restoreEnv();
});

afterAll(async () => {
  await removeTestUsers();
  const { prisma } = await import("@workspace-video/db");
  await prisma.$disconnect();
});

describe("POST /api/auth/dev-signin", () => {
  describe("is switched off unless both conditions hold", () => {
    it("404s in production even with ENABLE_DEV_AUTH=true, never looks anyone up, and sets no cookie", async () => {
      const { POST } = await loadRoute({ NODE_ENV: "production", ENABLE_DEV_AUTH: "true" });
      lookups.findUnique.mockClear();
      const res = await POST(post({ email: SEEDED_EMAIL }));
      expect(res.status).toBe(404);
      expect(lookups.findUnique).not.toHaveBeenCalled();
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("404s in development when ENABLE_DEV_AUTH is not set", async () => {
      const { POST } = await loadRoute({ NODE_ENV: "development" });
      lookups.findUnique.mockClear();
      const res = await POST(post({ email: SEEDED_EMAIL }));
      expect(res.status).toBe(404);
      expect(lookups.findUnique).not.toHaveBeenCalled();
    });

    it("404s in development for any ENABLE_DEV_AUTH value other than exactly 'true'", async () => {
      for (const value of ["1", "TRUE", "yes", ""]) {
        const { POST } = await loadRoute({ NODE_ENV: "development", ENABLE_DEV_AUTH: value });
        lookups.findUnique.mockClear();
        expect((await POST(post({ email: SEEDED_EMAIL }))).status, `ENABLE_DEV_AUTH=${JSON.stringify(value)}`).toBe(404);
        expect(lookups.findUnique).not.toHaveBeenCalled();
      }
    });
  });

  describe("when enabled (development + ENABLE_DEV_AUTH=true)", () => {
    const enabled = { NODE_ENV: "development", ENABLE_DEV_AUTH: "true" };

    it("signs a seeded user in with a real Better Auth session cookie that the app accepts", async () => {
      const { POST } = await loadRoute(enabled);
      const res = await POST(post({ email: SEEDED_EMAIL }));

      expect(res.status).toBe(200);
      const { prisma } = await import("@workspace-video/db");
      const user = await prisma.user.findUniqueOrThrow({ where: { email: SEEDED_EMAIL } });
      expect(await res.json()).toEqual({ ok: true, user: { id: user.id, email: SEEDED_EMAIL, name: "Dev User" } });

      const setCookies = res.headers.getSetCookie();
      const session = setCookies.find((c) => /session_token=/.test(c));
      expect(session).toBeDefined();
      expect(session).toMatch(/HttpOnly/i);
      expect(session).toMatch(/SameSite=Lax/i);

      // The same cookie must work against a Better Auth instance with the same secret and address.
      const cookie = setCookies.map((c) => c.split(";")[0]).join("; ");
      const { auth } = makeTestAuth(TEST_BASE_URL, AUTH_SECRET);
      const seen = await auth.api.getSession({ headers: new Headers({ cookie }) });
      expect(seen?.user.id).toBe(user.id);
    });

    it("does not create an account: an email that is not seeded gets 401 and no cookie", async () => {
      const { POST } = await loadRoute(enabled);
      const nobody = `nobody-${Date.now()}${TEST_DOMAIN}`;
      const res = await POST(post({ email: nobody }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "No such seeded user." });
      expect(res.headers.get("set-cookie")).toBeNull();
      const { prisma } = await import("@workspace-video/db");
      expect(await prisma.user.count({ where: { email: nobody } })).toBe(0);
    });

    it("trims and lower-cases the email before looking it up", async () => {
      const { POST } = await loadRoute(enabled);
      lookups.findUnique.mockClear();
      await POST(post({ email: `  ${SEEDED_EMAIL.toUpperCase()} ` }));
      expect(lookups.findUnique).toHaveBeenCalledWith({ where: { email: SEEDED_EMAIL } });
    });

    it.each([
      ["a missing email", {}],
      ["a non-string email", { email: 42 }],
      ["a body that is not JSON", "not json"],
    ])("400s for %s, without a database lookup", async (_label, body) => {
      const { POST } = await loadRoute(enabled);
      lookups.findUnique.mockClear();
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(lookups.findUnique).not.toHaveBeenCalled();
    });
  });
});
