// @vitest-environment node
import { describe, it, expect, afterAll, afterEach, vi } from "vitest";
import { prisma } from "@workspace-video/db";
import { restoreEnv } from "@/lib/__tests__/helpers/testEnv";
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
  const { GET } = await import("../session/route");
  return { ...kit, GET };
}

describe("GET /api/auth/session", () => {
  it("401s when signed out", async () => {
    const { GET, useCookie } = await loadRoute();
    await useCookie(undefined);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });
  });

  it("401s when the user has since been deleted (their sessions go with them)", async () => {
    const { GET, t, useCookie } = await loadRoute();
    const email = uniqueTestEmail();
    await useCookie(await signIn(t, email));
    await prisma.user.delete({ where: { email } });
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });
  });

  it("returns only id, email and name for a signed-in user", async () => {
    const { GET, t, useCookie } = await loadRoute();
    const email = uniqueTestEmail();
    await useCookie(await signIn(t, email));
    const res = await GET();
    expect(res.status).toBe(200);
    const { user } = (await res.json()) as { user: Record<string, unknown> };
    expect(Object.keys(user).sort()).toEqual(["email", "id", "name"]);
    expect(user.email).toBe(email);
  });
});
