import { resolveSecret } from "@cosmos/shared";

/** Central place for realtime-server environment configuration and parsing. */

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const env = {
  port: Number(process.env.PORT ?? 4001),
  // The URL other instances / Next.js should use to reach this realtime
  // process directly (behind a load balancer this is the per-instance address,
  // not the LB's). Required for the sticky room-ownership endpoint lookup.
  publicUrl: required("REALTIME_PUBLIC_URL", `http://localhost:${process.env.PORT ?? 4001}`),
  redisUrl: required("REDIS_URL", "redis://localhost:6379"),
  databaseUrl: required("DATABASE_URL", "postgresql://cosmos:cosmos@localhost:5432/cosmos"),
  // Shared with Next.js/Auth.js — used to verify the session token clients
  // present at socket handshake. In dev, falls back to a fixed value so the
  // two processes agree without extra setup. In production a missing, blank or
  // public-default value stops the server at start (see resolveSecret).
  authSecret: resolveSecret(process.env, "AUTH_SECRET", "dev-only-insecure-secret-change-me"),
  instanceHeartbeatTtlSeconds: 30,
  roomLeaseTtlSeconds: 30,
};
