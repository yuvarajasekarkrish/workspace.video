import { nanoid } from "nanoid";
import { Redis } from "ioredis";
import { InstanceRegistry, RoomLease } from "@cosmos/realtime-core";
import { env } from "./env";

export const instanceId = `realtime-${nanoid(10)}`;

// Two Redis connections by convention: one for the Socket.IO adapter
// (pub/sub, put into subscriber mode) and one for everything else (instance
// registry, room lease) — the adapter's subscriber connection can't issue
// normal commands once subscribed.
export const redisPub = new Redis(env.redisUrl);
export const redisSub = redisPub.duplicate();
export const redisCommands = new Redis(env.redisUrl);

/** Phase 10 instrumentation: counts every PUBLISH issued on `redisPub`,
 *  which is also the connection `@socket.io/redis-adapter` uses to fan out
 *  every `io.to(...).emit(...)` call to other instances — see the Phase 10
 *  plan's L1 lead. Monkey-patched rather than routed through a wrapper type
 *  so the adapter (constructed with `redisPub` directly in server.ts) picks
 *  up the counting with no change to how it's constructed. Never changes
 *  publish behavior — every call is forwarded unchanged. */
export const redisPublishStats = { count: 0 };
const originalPublish = redisPub.publish.bind(redisPub);
redisPub.publish = ((...args: Parameters<typeof originalPublish>) => {
  redisPublishStats.count++;
  return originalPublish(...args);
}) as typeof redisPub.publish;

export const instanceRegistry = new InstanceRegistry(redisCommands, {
  ttlSeconds: env.instanceHeartbeatTtlSeconds,
});
export const roomLease = new RoomLease(redisCommands, env.roomLeaseTtlSeconds);

let heartbeatTimer: NodeJS.Timeout | undefined;

export function startHeartbeat(): void {
  const beat = () =>
    instanceRegistry
      .heartbeat({ instanceId, publicUrl: env.publicUrl })
      .catch((err) => console.error("[instance] heartbeat failed", err));

  void beat();
  // Refresh well under the TTL so a transient delay/hiccup doesn't let the
  // registration lapse and get treated as dead by resolveRoomEndpoint.
  heartbeatTimer = setInterval(beat, (env.instanceHeartbeatTtlSeconds * 1000) / 3);
}

export async function stopHeartbeat(): Promise<void> {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await instanceRegistry.deregister(instanceId);
}
