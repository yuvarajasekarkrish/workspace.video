import { resolveSecret } from "@cosmos/shared";

/** Central environment configuration for apps/web, server-side only. */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Dev-only "sign in as" flow (see lib/session.ts) is hard-gated behind
  // BOTH of these — never enabled by NODE_ENV alone, so a misconfigured
  // deploy can't accidentally expose it.
  devAuthEnabled: process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_AUTH === "true",
  // Shared with apps/realtime — the same secret verifies both the app
  // session cookie and the realtime handshake token in this milestone. This
  // is a deliberate, temporary coupling: Phase 2 splits AUTH_SECRET (Auth.js
  // sessions) from a distinct REALTIME_JWT_SECRET (realtime tokens) once
  // real identity provisioning replaces the dev sign-in flow.
  authSecret: resolveSecret(process.env, "AUTH_SECRET", "dev-only-insecure-secret-change-me"),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  databaseUrl: required("DATABASE_URL", "postgresql://cosmos:cosmos@localhost:5432/cosmos"),
  roomLeaseTtlSeconds: 30,
  instanceHeartbeatTtlSeconds: 30,
  // LiveKit media server. Read purely from env (not hardcoded anywhere else)
  // so pointing at LiveKit Cloud later is a config change, not a code
  // change. Defaults match the dev keypair in the repo's livekit.yaml /
  // docker-compose.yml service, so `docker compose up -d` needs no extra
  // setup, mirroring how Postgres/Redis already work. LIVEKIT_API_SECRET is
  // intentionally a DISTINCT secret from AUTH_SECRET — no repeat of the
  // temporary realtime-token secret-reuse documented above.
  livekitUrl: required("LIVEKIT_URL", "ws://localhost:7880"),
  // In production all three secrets must be set to private values: a missing,
  // blank or public-default one stops the app at start (see resolveSecret).
  livekitApiKey: resolveSecret(process.env, "LIVEKIT_API_KEY", "devkey"),
  livekitApiSecret: resolveSecret(process.env, "LIVEKIT_API_SECRET", "dev-livekit-secret-change-me-32chars-min"),
};
