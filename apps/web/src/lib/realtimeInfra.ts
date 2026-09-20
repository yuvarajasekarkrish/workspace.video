import "server-only";
import { Redis } from "ioredis";
import { RoomLease, InstanceRegistry } from "@workspace-video/realtime-core";
import { env } from "./env";

/**
 * Server-only Redis wiring for the room-ownership lease, mirroring
 * apps/realtime/src/instance.ts's configuration (same TTLs) so this process
 * and the realtime instances agree on lease semantics. Never import this
 * from a client component — ioredis has no browser build.
 *
 * Cached on `globalThis`, the same pattern @workspace-video/db uses for its Prisma
 * client: Next.js dev (Turbopack/webpack HMR) can re-evaluate a route
 * module on every request, and without this guard a fresh ioredis client —
 * and its underlying TCP connection/handshake — would be created per
 * request instead of once, which measurably (order of seconds, sometimes
 * much worse depending on OS-level connection-setup overhead) slows down
 * every call to the room-endpoint route. Production module semantics don't
 * re-evaluate on every request, so this is a pure safety net there.
 */
const globalForRedis = globalThis as unknown as {
  workspaceVideoRedis?: Redis;
  workspaceVideoRoomLease?: RoomLease;
  workspaceVideoInstanceRegistry?: InstanceRegistry;
};

const redis = globalForRedis.workspaceVideoRedis ?? new Redis(env.redisUrl);

export const roomLease =
  globalForRedis.workspaceVideoRoomLease ?? new RoomLease(redis, env.roomLeaseTtlSeconds);
export const instanceRegistry =
  globalForRedis.workspaceVideoInstanceRegistry ??
  new InstanceRegistry(redis, { ttlSeconds: env.instanceHeartbeatTtlSeconds });

if (env.nodeEnv !== "production") {
  globalForRedis.workspaceVideoRedis = redis;
  globalForRedis.workspaceVideoRoomLease = roomLease;
  globalForRedis.workspaceVideoInstanceRegistry = instanceRegistry;
}
