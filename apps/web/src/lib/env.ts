import { resolveSecret, DEV_REALTIME_JWT_SECRET } from "@cosmos/shared";

/** Central environment configuration for apps/web, server-side only. */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// AUTH_SECRET signs the 7-day sign-in cookie, which is httpOnly. The 1-hour
// realtime token is different: browser JavaScript has to read it to open the
// socket. Signed with the same secret, a leaked socket token would verify as a
// sign-in cookie, so the two are separate secrets, and production refuses to
// start if they are the same value.
const authSecret = resolveSecret(process.env, "AUTH_SECRET", "dev-only-insecure-secret-change-me");
const realtimeJwtSecret = resolveSecret(process.env, "REALTIME_JWT_SECRET", DEV_REALTIME_JWT_SECRET);
if (process.env.NODE_ENV === "production" && realtimeJwtSecret === authSecret) {
  throw new Error(
    "Refusing to start in production: REALTIME_JWT_SECRET must be a different value from AUTH_SECRET. " +
      "Generate a second one with: openssl rand -hex 32",
  );
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  // Dev-only "sign in as" flow (see lib/session.ts) is hard-gated behind
  // BOTH of these — never enabled by NODE_ENV alone, so a misconfigured
  // deploy can't accidentally expose it.
  devAuthEnabled: process.env.NODE_ENV !== "production" && process.env.ENABLE_DEV_AUTH === "true",
  // Signs and verifies the sign-in cookie. Not shared with apps/realtime.
  authSecret,
  // Signs the short-lived socket token; apps/realtime verifies it with the same
  // value (its REALTIME_JWT_SECRET). Not used for the sign-in cookie.
  realtimeJwtSecret,
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  databaseUrl: required("DATABASE_URL", "postgresql://cosmos:cosmos@localhost:5432/cosmos"),
  roomLeaseTtlSeconds: 30,
  instanceHeartbeatTtlSeconds: 30,
  // LiveKit media server. Read purely from env (not hardcoded anywhere else)
  // so pointing at LiveKit Cloud later is a config change, not a code
  // change. Defaults match the dev keypair in the repo's livekit.yaml /
  // docker-compose.yml service, so `docker compose up -d` needs no extra
  // setup, mirroring how Postgres/Redis already work. LIVEKIT_API_SECRET is
  // intentionally a DISTINCT secret from AUTH_SECRET and REALTIME_JWT_SECRET.
  livekitUrl: required("LIVEKIT_URL", "ws://localhost:7880"),
  // In production all three secrets must be set to private values: a missing,
  // blank or public-default one stops the app at start (see resolveSecret).
  livekitApiKey: resolveSecret(process.env, "LIVEKIT_API_KEY", "devkey"),
  livekitApiSecret: resolveSecret(process.env, "LIVEKIT_API_SECRET", "dev-livekit-secret-change-me-32chars-min"),
};
