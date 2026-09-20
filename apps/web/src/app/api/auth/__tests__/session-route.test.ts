// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { REAL_ENV, setEnv, restoreEnv } from "@/lib/__tests__/helpers/testEnv";

const findUnique = vi.hoisted(() => vi.fn());
vi.mock("@workspace-video/db", () => ({ prisma: { user: { findUnique } } }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));

const USER = { userId: "user-1", email: "user-1@example.com" };
const ROW = { id: "user-1", email: "user-1@example.com", name: "User One" };

async function loadRoute(signedIn: boolean) {
  setEnv({ ...REAL_ENV, NODE_ENV: "production" });
  vi.resetModules();
  const session = await import("@/lib/session");
  const value = signedIn ? session.signSessionToken(USER) : undefined;
  const { cookies } = await import("next/headers");
  vi.mocked(cookies).mockResolvedValue({
    get: (name: string) => (name === session.SESSION_COOKIE_NAME && value ? { name, value } : undefined),
  } as never);
  return import("../session/route");
}

describe("GET /api/auth/session", () => {
  afterEach(() => {
    restoreEnv();
    findUnique.mockReset();
  });

  it("401s when signed out, without a database lookup", async () => {
    const { GET } = await loadRoute(false);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("401s when the cookie is valid but the user no longer exists", async () => {
    findUnique.mockResolvedValue(null);
    const { GET } = await loadRoute(true);
    const res = await GET();
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Not signed in." });
  });

  it("returns only id, email and name for a signed-in user", async () => {
    findUnique.mockResolvedValue(ROW);
    const { GET } = await loadRoute(true);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: ROW });
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: USER.userId },
      select: { id: true, email: true, name: true },
    });
  });
});
