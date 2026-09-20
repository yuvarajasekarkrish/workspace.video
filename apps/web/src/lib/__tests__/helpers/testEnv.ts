import { vi } from "vitest";

/** Shared setup for tests that import env.ts (directly or through session.ts).
 *  env.ts evaluates at import, so a test sets the environment, resets the module
 *  cache, and imports fresh. Values are real-looking and distinct, so the
 *  production guards in env.ts accept them. */

export const AUTH_SECRET = "a-real-auth-secret-0123456789abcdef0123456789abcdef";
export const REALTIME_JWT_SECRET = "a-different-realtime-secret-fedcba9876543210fedcba98765432";

export const REAL_ENV: Record<string, string> = {
  AUTH_SECRET,
  REALTIME_JWT_SECRET,
  LIVEKIT_API_KEY: "APIrealKey123",
  LIVEKIT_API_SECRET: "a-real-livekit-secret-0123456789abcdef0123456789",
  DATABASE_URL: "postgresql://app:a-strong-password@db.internal:5432/workspace",
  APP_URL: "https://www.workspace.video",
};

const saved = new Map<string, string | undefined>();

/** Sets (or, for `undefined`, removes) process.env entries; `restoreEnv` undoes it. */
export function setEnv(values: Record<string, string | undefined>): void {
  const env = process.env as Record<string, string | undefined>;
  for (const [key, value] of Object.entries(values)) {
    if (!saved.has(key)) saved.set(key, env[key]);
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
}

export function restoreEnv(): void {
  const env = process.env as Record<string, string | undefined>;
  for (const [key, value] of saved) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  saved.clear();
  vi.resetModules();
}
