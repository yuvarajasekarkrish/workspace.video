import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** apps/realtime/src/env.ts evaluates at import, so each case sets the process
 *  environment, resets the module cache, and imports it fresh.
 *
 *  The realtime server verifies socket tokens with REALTIME_JWT_SECRET. It does
 *  not know the web app's sign-in secret (AUTH_SECRET) at all. */

const DEV_REALTIME_JWT_SECRET = "dev-only-insecure-realtime-secret-change-me";
const REAL_SECRET = "a-different-realtime-secret-fedcba9876543210fedcba98765432";

function setVar(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function loadEnv() {
  vi.resetModules();
  return (await import("../env.js")).env;
}

describe("realtime env: REALTIME_JWT_SECRET in production", () => {
  let savedRealtime: string | undefined;
  let savedAuth: string | undefined;

  beforeEach(() => {
    savedRealtime = process.env.REALTIME_JWT_SECRET;
    savedAuth = process.env.AUTH_SECRET;
  });

  afterEach(() => {
    setVar("REALTIME_JWT_SECRET", savedRealtime);
    setVar("AUTH_SECRET", savedAuth);
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe("in production", () => {
    beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

    it("refuses to start when REALTIME_JWT_SECRET is not set", async () => {
      setVar("REALTIME_JWT_SECRET", undefined);
      await expect(loadEnv()).rejects.toThrow(/REALTIME_JWT_SECRET/);
    });

    it("refuses to start when REALTIME_JWT_SECRET is the public dev default", async () => {
      setVar("REALTIME_JWT_SECRET", DEV_REALTIME_JWT_SECRET);
      await expect(loadEnv()).rejects.toThrow(/REALTIME_JWT_SECRET/);
    });

    it("refuses to start when REALTIME_JWT_SECRET is empty or only spaces", async () => {
      setVar("REALTIME_JWT_SECRET", "");
      await expect(loadEnv()).rejects.toThrow(/REALTIME_JWT_SECRET/);
      setVar("REALTIME_JWT_SECRET", "   ");
      await expect(loadEnv()).rejects.toThrow(/REALTIME_JWT_SECRET/);
    });

    it("does not accept the web sign-in secret in its place", async () => {
      setVar("REALTIME_JWT_SECRET", undefined);
      setVar("AUTH_SECRET", "a-real-auth-secret-0123456789abcdef0123456789abcdef");
      await expect(loadEnv()).rejects.toThrow(/REALTIME_JWT_SECRET/);
    });

    it("starts and uses the value when it is real", async () => {
      setVar("REALTIME_JWT_SECRET", REAL_SECRET);
      expect((await loadEnv()).realtimeJwtSecret).toBe(REAL_SECRET);
    });
  });

  describe("outside production (dev workflow must keep working with no setup)", () => {
    it.each(["development", "test"])("falls back to the dev default when NODE_ENV=%s", async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      setVar("REALTIME_JWT_SECRET", undefined);
      expect((await loadEnv()).realtimeJwtSecret).toBe(DEV_REALTIME_JWT_SECRET);
    });
  });
});
