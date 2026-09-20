// @vitest-environment node
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { prisma } from "@workspace-video/db";
import { AUTH_SECRET, REALTIME_JWT_SECRET, restoreEnv } from "./helpers/testEnv";
import { authMockFactory, bootstrap, removeTestUsers, signIn, uniqueTestEmail } from "./helpers/testAuth";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => authMockFactory());

const USER = { userId: "user-1", email: "user-1@example.com" };

afterEach(() => restoreEnv());
afterAll(async () => {
  await removeTestUsers();
  await prisma.$disconnect();
});

describe("the realtime (socket) token", () => {
  it("is signed with REALTIME_JWT_SECRET and not the sign-in secret, and lasts one hour", async () => {
    await bootstrap();
    const { signRealtimeToken } = await import("../session");
    const token = signRealtimeToken(USER);
    const claims = jwt.verify(token, REALTIME_JWT_SECRET) as jwt.JwtPayload;
    expect(claims.sub).toBe(USER.userId);
    expect(claims.email).toBe(USER.email);
    expect(claims.exp! - claims.iat!).toBe(60 * 60);
    expect(() => jwt.verify(token, AUTH_SECRET)).toThrow();
  });
});

describe("getSessionUser (reads the sign-in cookie of the current request)", () => {
  /** Signs `email` in for real, points the request at that cookie, and returns helpers. */
  async function signedInAs(email = uniqueTestEmail()) {
    const { t, useCookie } = await bootstrap();
    const cookie = await signIn(t, email);
    await useCookie(cookie);
    const { getSessionUser } = await import("../session");
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { getSessionUser, useCookie, cookie, email, user };
  }
  const cookieName = (cookie: string) => cookie.split("=")[0]!;

  it("returns the user for a valid session cookie", async () => {
    const { getSessionUser, email, user } = await signedInAs();
    expect(await getSessionUser()).toEqual({ userId: user.id, email });
  });

  it("returns null when there is no cookie", async () => {
    const { getSessionUser, useCookie } = await signedInAs();
    await useCookie(undefined);
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null, without throwing, for a cookie that is not a session", async () => {
    const { getSessionUser, useCookie, cookie } = await signedInAs();
    await useCookie(`${cookieName(cookie)}=garbage`);
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null for a cookie whose signature was altered", async () => {
    const { getSessionUser, useCookie, cookie } = await signedInAs();
    await useCookie(cookie.replace(/=(.*)$/, (_m, value: string) => `=${value.slice(0, -8)}AAAAAAAA`));
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null once the session has expired", async () => {
    const { getSessionUser, user } = await signedInAs();
    await prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null once the session has been revoked (its row deleted)", async () => {
    const { getSessionUser, user } = await signedInAs();
    await prisma.session.deleteMany({ where: { userId: user.id } });
    expect(await getSessionUser()).toBeNull();
  });

  it("returns null for a socket token presented as the sign-in cookie", async () => {
    const { getSessionUser, useCookie, cookie } = await signedInAs();
    const { signRealtimeToken } = await import("../session");
    await useCookie(`${cookieName(cookie)}=${signRealtimeToken(USER)}`);
    expect(await getSessionUser()).toBeNull();
  });
});
