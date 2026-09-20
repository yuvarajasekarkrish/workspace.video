import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** apps/realtime/src/env.ts evaluates at import, so each case sets the process
 *  environment, resets the module cache, and imports it fresh.
 *
 *  The realtime server verifies socket tokens with REALTIME_JWT_SECRET. It does
 *  not know the web app's sign-in secret (AUTH_SECRET) at all. */

const DEV_REALTIME_JWT_SECRET = "dev-only-insecure-realtime-secret-change-me";
const REAL_SECRET = "a-different-realtime-secret-fedcba9876543210fedcba98765432";
const DEV_DATABASE_URL = "postgresql://workspace:workspace@localhost:5432/workspace_video";
const REAL_DATABASE_URL = "postgresql://app:a-strong-password@db.internal:5432/workspace";
const DEV_METRICS_TOKEN = "dev-only-insecure-metrics-token";
const REAL_METRICS_TOKEN = "a-long-random-metrics-token-0123456789abcdef";

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
  let savedDatabase: string | undefined;
  let savedMetrics: string | undefined;

  beforeEach(() => {
    savedRealtime = process.env.REALTIME_JWT_SECRET;
    savedAuth = process.env.AUTH_SECRET;
    savedDatabase = process.env.DATABASE_URL;
    savedMetrics = process.env.INTERNAL_METRICS_TOKEN;
    setVar("DATABASE_URL", REAL_DATABASE_URL);
    setVar("INTERNAL_METRICS_TOKEN", REAL_METRICS_TOKEN);
  });

  afterEach(() => {
    setVar("REALTIME_JWT_SECRET", savedRealtime);
    setVar("AUTH_SECRET", savedAuth);
    setVar("DATABASE_URL", savedDatabase);
    setVar("INTERNAL_METRICS_TOKEN", savedMetrics);
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

    it("refuses to start when DATABASE_URL is not set or is the public dev default (it carries a password)", async () => {
      setVar("REALTIME_JWT_SECRET", REAL_SECRET);
      setVar("DATABASE_URL", undefined);
      await expect(loadEnv()).rejects.toThrow(/DATABASE_URL/);
      setVar("DATABASE_URL", DEV_DATABASE_URL);
      await expect(loadEnv()).rejects.toThrow(/DATABASE_URL/);
    });

    it("refuses to start when INTERNAL_METRICS_TOKEN is not set, blank, or the public dev default", async () => {
      setVar("REALTIME_JWT_SECRET", REAL_SECRET);
      for (const value of [undefined, "", "   ", DEV_METRICS_TOKEN]) {
        setVar("INTERNAL_METRICS_TOKEN", value);
        await expect(loadEnv(), JSON.stringify(value)).rejects.toThrow(/INTERNAL_METRICS_TOKEN/);
      }
    });

    it("starts and uses the values when they are real", async () => {
      setVar("REALTIME_JWT_SECRET", REAL_SECRET);
      const env = await loadEnv();
      expect(env.realtimeJwtSecret).toBe(REAL_SECRET);
      expect(env.databaseUrl).toBe(REAL_DATABASE_URL);
      expect(env.internalMetricsToken).toBe(REAL_METRICS_TOKEN);
    });
  });

  describe("outside production (dev workflow must keep working with no setup)", () => {
    it.each(["development", "test"])("falls back to the dev default when NODE_ENV=%s", async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      setVar("REALTIME_JWT_SECRET", undefined);
      setVar("DATABASE_URL", undefined);
      setVar("INTERNAL_METRICS_TOKEN", undefined);
      const env = await loadEnv();
      expect(env.realtimeJwtSecret).toBe(DEV_REALTIME_JWT_SECRET);
      expect(env.internalMetricsToken).toBe(DEV_METRICS_TOKEN);
      expect(env.databaseUrl).toBe(DEV_DATABASE_URL);
    });
  });
});
