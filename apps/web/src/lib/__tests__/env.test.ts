import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

/** apps/web/src/lib/env.ts evaluates at import, so each case sets the process
 *  environment, resets the module cache, and imports it fresh. */

const DEV_AUTH_SECRET = "dev-only-insecure-secret-change-me";
const DEV_REALTIME_JWT_SECRET = "dev-only-insecure-realtime-secret-change-me";
const DEV_LIVEKIT_KEY = "devkey";
const DEV_LIVEKIT_SECRET = "dev-livekit-secret-change-me-32chars-min";

const DEV_DATABASE_URL = "postgresql://workspace:workspace@localhost:5432/workspace_video";

const KEYS = ["AUTH_SECRET", "REALTIME_JWT_SECRET", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "DATABASE_URL"] as const;
type Key = (typeof KEYS)[number];

const REAL: Record<Key, string> = {
  DATABASE_URL: "postgresql://app:a-strong-password@db.internal:5432/workspace",
  AUTH_SECRET: "a-real-auth-secret-0123456789abcdef0123456789abcdef",
  REALTIME_JWT_SECRET: "a-different-realtime-secret-fedcba9876543210fedcba98765432",
  LIVEKIT_API_KEY: "APIrealKey123",
  LIVEKIT_API_SECRET: "a-real-livekit-secret-0123456789abcdef0123456789",
};

function setEnv(values: Partial<Record<Key, string | undefined>>) {
  for (const key of KEYS) {
    const value = key in values ? values[key] : undefined;
    if (value === undefined) delete (process.env as Record<string, string | undefined>)[key];
    else (process.env as Record<string, string | undefined>)[key] = value;
  }
}

async function loadEnv() {
  vi.resetModules();
  return (await import("../env")).env;
}

describe("web env: secrets in production", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete (process.env as Record<string, string | undefined>)[key];
      else (process.env as Record<string, string | undefined>)[key] = saved[key];
    }
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  describe("in production", () => {
    beforeEach(() => vi.stubEnv("NODE_ENV", "production"));

    it("refuses to start when AUTH_SECRET is not set", async () => {
      setEnv({ ...REAL, AUTH_SECRET: undefined });
      await expect(loadEnv()).rejects.toThrow(/AUTH_SECRET/);
    });

    it("refuses to start when AUTH_SECRET is the public dev default", async () => {
      setEnv({ ...REAL, AUTH_SECRET: DEV_AUTH_SECRET });
      await expect(loadEnv()).rejects.toThrow(/AUTH_SECRET/);
    });

    it("refuses to start when AUTH_SECRET is empty or only spaces", async () => {
      setEnv({ ...REAL, AUTH_SECRET: "" });
      await expect(loadEnv()).rejects.toThrow(/AUTH_SECRET/);
      setEnv({ ...REAL, AUTH_SECRET: "   " });
      await expect(loadEnv()).rejects.toThrow(/AUTH_SECRET/);
    });

    it("refuses to start when REALTIME_JWT_SECRET is not set or is the dev default", async () => {
      setEnv({ ...REAL, REALTIME_JWT_SECRET: undefined });
      await expect(loadEnv()).rejects.toThrow(/REALTIME_JWT_SECRET/);
      setEnv({ ...REAL, REALTIME_JWT_SECRET: DEV_REALTIME_JWT_SECRET });
      await expect(loadEnv()).rejects.toThrow(/REALTIME_JWT_SECRET/);
    });

    it("refuses to start when REALTIME_JWT_SECRET is the same value as AUTH_SECRET", async () => {
      setEnv({ ...REAL, REALTIME_JWT_SECRET: REAL.AUTH_SECRET });
      await expect(loadEnv()).rejects.toThrow(/REALTIME_JWT_SECRET.*AUTH_SECRET|AUTH_SECRET.*REALTIME_JWT_SECRET/);
    });

    it("refuses to start when LIVEKIT_API_KEY is not set or is the dev default", async () => {
      setEnv({ ...REAL, LIVEKIT_API_KEY: undefined });
      await expect(loadEnv()).rejects.toThrow(/LIVEKIT_API_KEY/);
      setEnv({ ...REAL, LIVEKIT_API_KEY: DEV_LIVEKIT_KEY });
      await expect(loadEnv()).rejects.toThrow(/LIVEKIT_API_KEY/);
    });

    it("refuses to start when LIVEKIT_API_SECRET is not set or is the dev default", async () => {
      setEnv({ ...REAL, LIVEKIT_API_SECRET: undefined });
      await expect(loadEnv()).rejects.toThrow(/LIVEKIT_API_SECRET/);
      setEnv({ ...REAL, LIVEKIT_API_SECRET: DEV_LIVEKIT_SECRET });
      await expect(loadEnv()).rejects.toThrow(/LIVEKIT_API_SECRET/);
    });

    it("refuses to start when DATABASE_URL is not set or is the public dev default (it carries a password)", async () => {
      setEnv({ ...REAL, DATABASE_URL: undefined });
      await expect(loadEnv()).rejects.toThrow(/DATABASE_URL/);
      setEnv({ ...REAL, DATABASE_URL: DEV_DATABASE_URL });
      await expect(loadEnv()).rejects.toThrow(/DATABASE_URL/);
    });

    it("gives database advice for DATABASE_URL, not 'random value' advice", async () => {
      setEnv({ ...REAL, DATABASE_URL: undefined });
      const error = await loadEnv().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message).not.toContain("openssl");
      expect(error?.message).toMatch(/database/i);
    });

    it("names the variable and says how to fix it, without printing the secret", async () => {
      setEnv({ ...REAL, AUTH_SECRET: DEV_AUTH_SECRET });
      const error = await loadEnv().then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(error?.message).toMatch(/AUTH_SECRET/);
      expect(error?.message).toMatch(/production/i);
      expect(error?.message).not.toContain(DEV_AUTH_SECRET);
    });

    it("starts and uses the values when all four are real and distinct", async () => {
      setEnv(REAL);
      const env = await loadEnv();
      expect(env.authSecret).toBe(REAL.AUTH_SECRET);
      expect(env.realtimeJwtSecret).toBe(REAL.REALTIME_JWT_SECRET);
      expect(env.livekitApiKey).toBe(REAL.LIVEKIT_API_KEY);
      expect(env.livekitApiSecret).toBe(REAL.LIVEKIT_API_SECRET);
      expect(env.databaseUrl).toBe(REAL.DATABASE_URL);
    });
  });

  describe("outside production (dev workflow must keep working with no setup)", () => {
    it.each(["development", "test"])("falls back to the dev defaults when NODE_ENV=%s", async (nodeEnv) => {
      vi.stubEnv("NODE_ENV", nodeEnv);
      setEnv({});
      const env = await loadEnv();
      expect(env.authSecret).toBe(DEV_AUTH_SECRET);
      expect(env.realtimeJwtSecret).toBe(DEV_REALTIME_JWT_SECRET);
      expect(env.livekitApiKey).toBe(DEV_LIVEKIT_KEY);
      expect(env.livekitApiSecret).toBe(DEV_LIVEKIT_SECRET);
      expect(env.databaseUrl).toBe(DEV_DATABASE_URL);
    });

    it("keeps the two dev secrets different, so the split is real even in development", async () => {
      vi.stubEnv("NODE_ENV", "development");
      setEnv({});
      const env = await loadEnv();
      expect(env.realtimeJwtSecret).not.toBe(env.authSecret);
    });
  });
});
