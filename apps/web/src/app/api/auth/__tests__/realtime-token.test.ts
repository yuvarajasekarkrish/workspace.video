// @vitest-environment node
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import jwt from "jsonwebtoken";
import { prisma } from "@workspace-video/db";
import { AUTH_SECRET, REALTIME_JWT_SECRET, restoreEnv } from "@/lib/__tests__/helpers/testEnv";
import { authMockFactory, bootstrap, removeTestUsers, signIn, uniqueTestEmail } from "@/lib/__tests__/helpers/testAuth";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/auth", () => authMockFactory());

afterEach(() => restoreEnv());
afterAll(async () => {
  await removeTestUsers();
  await prisma.$disconnect();
});

async function loadRoute() {
  const kit = await bootstrap();
  const { GET } = await import("../realtime-token/route");
  return { ...kit, GET };
}

describe("GET /api/auth/realtime-token", () => {
  it("401s when signed out", async () => {
    const { GET, useCookie } = await loadRoute();
    await useCookie(undefined);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });
  });

  it("401s for a cookie that is not a valid session", async () => {
    const { GET, t, useCookie } = await loadRoute();
    const cookie = await signIn(t, uniqueTestEmail());
    await useCookie(`${cookie.split("=")[0]}=garbage`);
    expect((await GET()).status).toBe(401);
  });

  it("401s for a socket token presented as the sign-in cookie", async () => {
    const { GET, t, useCookie } = await loadRoute();
    const cookie = await signIn(t, uniqueTestEmail());
    const { signRealtimeToken } = await import("@/lib/session");
    await useCookie(`${cookie.split("=")[0]}=${signRealtimeToken({ userId: "u", email: "u@example.com" })}`);
    expect((await GET()).status).toBe(401);
  });

  it("when signed in, returns a 1-hour token for that user, signed with REALTIME_JWT_SECRET and not the sign-in secret", async () => {
    const { GET, t, useCookie } = await loadRoute();
    const email = uniqueTestEmail();
    await useCookie(await signIn(t, email));
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });

    const res = await GET();

    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    const claims = jwt.verify(token, REALTIME_JWT_SECRET) as jwt.JwtPayload;
    expect(claims.sub).toBe(user.id);
    expect(claims.email).toBe(email);
    expect(claims.exp! - claims.iat!).toBe(60 * 60);
    expect(() => jwt.verify(token, AUTH_SECRET)).toThrow();
  });
});
