import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** apps/realtime/src/env.ts evaluates at import, so each case sets the process
 *  environment, resets the module cache, and imports it fresh. */

const DEV_AUTH_SECRET = "dev-only-insecure-secret-change-me";
const REAL_AUTH_SECRET = "a-real-auth-secret-0123456789abcdef0123456789abcdef";

function setAuthSecret(value: string | undefined) {
  if (value === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = value;
}

async function loadEnv() {
  vi.resetModules();
  return (await import("../env.js")).env;
}

describe("realtime env: AUTH_SECRET in production", () => {
  let saved: string | undefined;

  beforeEach(() => {
    saved = process.env.AUTH_SECRET;
  });

  afterEach(() => {
    setAuthSecret(saved);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe("in production", () => {
    beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

    it("refuses to start when AUTH_SECRET is not set", async () => {
      setAuthSecret(undefined);
      await expect(loadEnv()).rejects.toThrow(/AUTH_SECRET/);
    });

    it("refuses to start when AUTH_SECRET is the public dev default", async () => {
      setAuthSecret(DEV_AUTH_SECRET);
      await expect(loadEnv()).rejects.toThrow(/AUTH_SECRET/);
    });

    it("refuses to start when AUTH_SECRET is empty or only spaces", async () => {
      setAuthSecret("");
      await expect(loadEnv()).rejects.toThrow(/AUTH_SECRET/);
      setAuthSecret("   ");
      await expect(loadEnv()).rejects.toThrow(/AUTH_SECRET/);
    });

    it("starts and uses the value when it is real", async () => {
      setAuthSecret(REAL_AUTH_SECRET);
      expect((await loadEnv()).authSecret).toBe(REAL_AUTH_SECRET);
    });
  });

  describe("outside production (dev workflow must keep working with no setup)", () => {
    it.each(["development", "test"])("falls back to the dev default when NODE_ENV=%s", async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      setAuthSecret(undefined);
      expect((await loadEnv()).authSecret).toBe(DEV_AUTH_SECRET);
    });
  });
});
