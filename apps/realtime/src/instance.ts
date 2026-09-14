import { nanoid } from "nanoid";
import { Redis } from "ioredis";
import { InstanceRegistry, RoomLease } from "@cosmos/realtime-core";
import { env } from "./env.js";

export const instanceId = `realtime-${nanoid(10)}`;

// Two Redis connections by convention: one for the Socket.IO adapter
// (pub/sub, put into subscriber mode) and one for everything else (instance
// registry, room lease) — the adapter's subscriber connection can't issue
// normal commands once subscribed.
export const redisPub = new Redis(env.redisUrl);
export const redisSub = redisPub.duplicate();
export const redisCommands = new Redis(env.redisUrl);

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
