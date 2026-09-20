import { required as requiredFrom, resolveSecret, resolveDatabaseUrl, DEV_REALTIME_JWT_SECRET } from "@workspace-video/shared";

/** Central place for realtime-server environment configuration and parsing. */

const required = (name: string, fallback?: string): string => requiredFrom(process.env, name, fallback);

export const env = {
  port: Number(process.env.PORT ?? 4001),
  // The URL other instances / Next.js should use to reach this realtime
  // process directly (behind a load balancer this is the per-instance address,
  // not the LB's). Required for the sticky room-ownership endpoint lookup.
  publicUrl: required("REALTIME_PUBLIC_URL", `http://localhost:${process.env.PORT ?? 4001}`),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  // The dev default carries a password, so production refuses it (see resolveDatabaseUrl).
  databaseUrl: resolveDatabaseUrl(process.env),
  // Verifies the short-lived token clients present at socket handshake; the web
  // app signs it with the same value. This server never sees the web app's
  // sign-in secret (AUTH_SECRET). In dev, falls back to a fixed value so the two
  // processes agree without extra setup. In production a missing, blank or
  // public-default value stops the server at start (see resolveSecret).
  realtimeJwtSecret: resolveSecret(process.env, "REALTIME_JWT_SECRET", DEV_REALTIME_JWT_SECRET),
  // Protects /internal/metrics in production (see internalRoutes.ts). A missing,
  // blank or public-default value stops the server at start.
  internalMetricsToken: resolveSecret(process.env, "INTERNAL_METRICS_TOKEN", "dev-only-insecure-metrics-token"),
  instanceHeartbeatTtlSeconds: 30,
  roomLeaseTtlSeconds: 30,
};
