// @vitest-environment node
import { describe, it, expect, vi } from "vitest";

// During `next build`, Next tries to prerender pages. Reading the request's headers
// is what tells it "this page is per-request, do not prerender": headers() throws
// a bail-out there. The sign-in setup must not be touched before that happens, or a
// production build dies on the missing email provider (found by the image build in CI).
const getAuth = vi.hoisted(() => vi.fn(() => ({ api: { getSession: async () => null } })));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => {
    throw new Error("DYNAMIC_SERVER_USAGE");
  }),
}));
vi.mock("@/lib/auth", () => ({ getAuth }));

describe("getSessionUser during a build-time prerender", () => {
  it("reads the request headers before it touches the sign-in setup", async () => {
    const { getSessionUser } = await import("../session");
    await expect(getSessionUser()).rejects.toThrow("DYNAMIC_SERVER_USAGE");
    expect(getAuth).not.toHaveBeenCalled();
  });
});
