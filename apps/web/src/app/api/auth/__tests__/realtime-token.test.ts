// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { AUTH_SECRET, REALTIME_JWT_SECRET, REAL_ENV, setEnv, restoreEnv } from "@/lib/__tests__/helpers/testEnv";

vi.mock("@workspace-video/db", () => ({ prisma: { user: { findUnique: vi.fn() } } }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const USER = { userId: "user-1", email: "user-1@example.com" };

/** Loads the route (and the session module it uses) in a production-like environment
 *  with the browser sending `cookieValue` as its sign-in cookie, or none. */
async function loadRoute(cookieValue: string | ((s: typeof import("@/lib/session")) => string) | undefined) {
  setEnv({ ...REAL_ENV, NODE_ENV: "production" });
  vi.resetModules();
  const session = await import("@/lib/session");
  const value = typeof cookieValue === "function" ? cookieValue(session) : cookieValue;
  const { cookies } = await import("next/headers");
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (name === session.SESSION_COOKIE_NAME && value ? { name, value } : undefined),
  } as never);
  return import("../realtime-token/route");
}

describe("GET /api/auth/realtime-token", () => {
  afterEach(() => restoreEnv());

  it("401s when signed out", async () => {
    const { GET } = await loadRoute(undefined);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });
  });

  it("401s for a cookie that is not a valid token", async () => {
    const { GET } = await loadRoute("garbage");
    expect((await GET()).status).toBe(401);
  });

  it("401s for a socket token presented as the sign-in cookie", async () => {
    const { GET } = await loadRoute((s) => s.signRealtimeToken(USER));
    expect((await GET()).status).toBe(401);
  });

  it("when signed in, returns a 1-hour token for that user, signed with REALTIME_JWT_SECRET and not the sign-in secret", async () => {
    const { GET } = await loadRoute((s) => s.signSessionToken(USER));
    const res = await GET();

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const claims = jwt.verify(token, REALTIME_JWT_SECRET) as jwt.JwtPayload;
    expect(claims.sub).toBe(USER.userId);
    expect(claims.email).toBe(USER.email);
    expect(claims.exp! - claims.iat!).toBe(60 * 60);
    expect(() => jwt.verify(token, AUTH_SECRET)).toThrow();
  });
});
