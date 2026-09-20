import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";

vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const AUTH_SECRET = "a-real-auth-secret-0123456789abcdef0123456789abcdef";
const REALTIME_JWT_SECRET = "a-different-realtime-secret-fedcba9876543210fedcba98765432";

const USER = { userId: "user-1", email: "user-1@example.com" };

/** session.ts reads its secrets through env.ts at import, so set the process
 *  environment to production values, reset the module cache, and import fresh. */
async function loadSession() {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("AUTH_SECRET", AUTH_SECRET);
  vi.stubEnv("REALTIME_JWT_SECRET", REALTIME_JWT_SECRET);
  vi.stubEnv("LIVEKIT_API_KEY", "APIrealKey123");
  vi.stubEnv("LIVEKIT_API_SECRET", "a-real-livekit-secret-0123456789abcdef0123456789");
  vi.stubEnv("DATABASE_URL", "postgresql://app:a-strong-password@db.internal:5432/workspace");
  vi.resetModules();
  return import("../session");
}

describe("session tokens use separate secrets", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("signs the realtime token with REALTIME_JWT_SECRET, not the sign-in secret", async () => {
    const { signRealtimeToken } = await loadSession();
    const token = signRealtimeToken(USER);
    expect(() => jwt.verify(token, REALTIME_JWT_SECRET)).not.toThrow();
    expect(() => jwt.verify(token, AUTH_SECRET)).toThrow();
  });

  it("signs the sign-in cookie with AUTH_SECRET, not the realtime secret", async () => {
    const { signSessionToken } = await loadSession();
    const token = signSessionToken(USER);
    expect(() => jwt.verify(token, AUTH_SECRET)).not.toThrow();
    expect(() => jwt.verify(token, REALTIME_JWT_SECRET)).toThrow();
  });

  it("does not accept a realtime token (which browser JavaScript can read) as a sign-in cookie", async () => {
    const { signRealtimeToken, verifySessionToken } = await loadSession();
    expect(() => verifySessionToken(signRealtimeToken(USER))).toThrow();
  });

  it("still accepts its own sign-in cookie", async () => {
    const { signSessionToken, verifySessionToken } = await loadSession();
    expect(verifySessionToken(signSessionToken(USER))).toEqual(USER);
  });
});

describe("getSessionUser (reads the sign-in cookie of the current request)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  /** Loads session.ts with the browser sending `cookieValue` (or no cookie). */
  async function loadWithCookie(cookieValue: string | ((s: Awaited<ReturnType<typeof loadSession>>) => string) | undefined) {
    const session = await loadSession();
    const value = typeof cookieValue === "function" ? cookieValue(session) : cookieValue;
    const { cookies } = await import("next/headers");
    vi.mocked(cookies).mockResolvedValue({
      get: (name: string) => (name === session.SESSION_COOKIE_NAME && value ? { name, value } : undefined),
    } as never);
    return session;
  }

  it("returns the user for a valid cookie", async () => {
    const { getSessionUser } = await loadWithCookie((s) => s.signSessionToken(USER));
    expect(await getSessionUser()).toEqual(USER);
  });

  it("returns null when there is no cookie", async () => {
    const { getSessionUser } = await loadWithCookie(undefined);
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null, without throwing, for a cookie that is not a token", async () => {
    const { getSessionUser } = await loadWithCookie("garbage");
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null for a token whose signature was altered", async () => {
    const { getSessionUser } = await loadWithCookie((s) => {
      const token = s.signSessionToken(USER);
      return token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    });
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const { getSessionUser } = await loadWithCookie(() =>
      jwt.sign({ sub: USER.userId, email: USER.email }, AUTH_SECRET, { expiresIn: -10 }),
    );
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null for a correctly signed token that lacks the email claim", async () => {
    const { getSessionUser } = await loadWithCookie(() => jwt.sign({ sub: USER.userId }, AUTH_SECRET, { expiresIn: "1h" }));
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null for a socket token presented as the sign-in cookie", async () => {
    const { getSessionUser } = await loadWithCookie((s) => s.signRealtimeToken(USER));
    expect(await getSessionUser()).toBeNull();
  });
});
