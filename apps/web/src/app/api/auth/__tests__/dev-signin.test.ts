// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { NextRequest } from "next/server";
import { AUTH_SECRET, REAL_ENV, setEnv, restoreEnv } from "@/lib/__tests__/helpers/testEnv";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@workspace-video/db", () => ({ prisma: { user: { findUnique } } }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const SEEDED = { id: "user-1", email: "test@example.com", name: "Test User" };

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

describe("POST /api/auth/dev-signin", () => {
  afterEach(() => {
    restoreEnv();
    findUnique.mockReset();
  });

  describe("is switched off unless both conditions hold", () => {
    it("404s in production even with ENABLE_DEV_AUTH=true, and never touches the database", async () => {
      const { POST } = await loadRoute({ NODE_ENV: "production", ENABLE_DEV_AUTH: "true" });
      const res = await POST(post({ email: SEEDED.email }));
      expect(res.status).toBe(404);
      expect(findUnique).not.toHaveBeenCalled();
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it("404s in development when ENABLE_DEV_AUTH is not set", async () => {
      const { POST } = await loadRoute({ NODE_ENV: "development" });
      const res = await POST(post({ email: SEEDED.email }));
      expect(res.status).toBe(404);
      expect(findUnique).not.toHaveBeenCalled();
    });

    it("404s in development for any ENABLE_DEV_AUTH value other than exactly 'true'", async () => {
      for (const value of ["1", "TRUE", "yes", ""]) {
        const { POST } = await loadRoute({ NODE_ENV: "development", ENABLE_DEV_AUTH: value });
        expect((await POST(post({ email: SEEDED.email }))).status, `ENABLE_DEV_AUTH=${JSON.stringify(value)}`).toBe(404);
      }
      expect(findUnique).not.toHaveBeenCalled();
    });
  });

  describe("when enabled (development + ENABLE_DEV_AUTH=true)", () => {
    const enabled = { NODE_ENV: "development", ENABLE_DEV_AUTH: "true" };

    it("signs a seeded user in: 200, a 7-day httpOnly lax cookie holding a token signed with AUTH_SECRET", async () => {
      findUnique.mockResolvedValue(SEEDED);
      const { POST } = await loadRoute(enabled);
      const { SESSION_COOKIE_NAME } = await import("@/lib/session");

      const res = await POST(post({ email: SEEDED.email }));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, user: SEEDED });
      const cookie = res.cookies.get(SESSION_COOKIE_NAME);
      expect(cookie).toBeDefined();
      expect(cookie).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 7 });
      const claims = jwt.verify(cookie!.value, AUTH_SECRET) as jwt.JwtPayload;
      expect(claims.sub).toBe(SEEDED.id);
      expect(claims.email).toBe(SEEDED.email);
    });

    it("trims and lower-cases the email before looking it up", async () => {
      findUnique.mockResolvedValue(SEEDED);
      const { POST } = await loadRoute(enabled);
      await POST(post({ email: "  Test@Example.COM " }));
      expect(findUnique).toHaveBeenCalledWith({ where: { email: "test@example.com" } });
    });

    it("401s for an email that is not a seeded user, and sets no cookie", async () => {
      findUnique.mockResolvedValue(null);
      const { POST } = await loadRoute(enabled);
      const res = await POST(post({ email: "nobody@example.com" }));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "No such seeded user." });
      expect(res.headers.get("set-cookie")).toBeNull();
    });

    it.each([
      ["a missing email", {}],
      ["a non-string email", { email: 42 }],
      ["a body that is not JSON", "not json"],
    ])("400s for %s, without a database lookup", async (_label, body) => {
      const { POST } = await loadRoute(enabled);
      const res = await POST(post(body));
      expect(res.status).toBe(400);
      expect(findUnique).not.toHaveBeenCalled();
    });
  });
});
