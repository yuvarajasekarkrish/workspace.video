import { describe, it, expect, afterAll } from "vitest";
import { Redis } from "ioredis";
import { RoomLease } from "../roomLease.js";
import { InstanceRegistry } from "../instanceRegistry.js";
import {
  resolveRoomEndpoint,
  NoLiveInstanceError,
} from "../resolveRoomEndpoint.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

afterAll(async () => {
  await redis.quit();
});

describe("resolveRoomEndpoint", () => {
  // See roomLease.test.ts: this suite hits a real shared Redis across
  // parallel test-file workers, so every test gets its own random room and
  // instance ids rather than relying on a global flushdb between tests.
  const roomId = () => `test-room-${crypto.randomUUID()}`;
  const instanceId = (label: string) => `${label}-${crypto.randomUUID()}`;

  it("resolves to a live instance's URL for a fresh room", async () => {
    const lease = new RoomLease(redis, 30);
    const registry = new InstanceRegistry(redis, { ttlSeconds: 30 });
    const a = instanceId("a");
    await registry.heartbeat({ instanceId: a, publicUrl: "http://a:4001" });

    const endpoint = await resolveRoomEndpoint(roomId(), lease, registry, async () => a);
    expect(endpoint).toEqual({ instanceId: a, publicUrl: "http://a:4001" });
  });

  it("every concurrent resolver for the same room gets the same endpoint", async () => {
    const lease = new RoomLease(redis, 30);
    const registry = new InstanceRegistry(redis, { ttlSeconds: 30 });
    const a = instanceId("a");
    const b = instanceId("b");
    await registry.heartbeat({ instanceId: a, publicUrl: "http://a:4001" });
    await registry.heartbeat({ instanceId: b, publicUrl: "http://b:4001" });
    const room = roomId();

    // Simulate several clients racing to resolve the endpoint at once, each
    // picking randomly between two live instances as their candidate.
    const pick = async () => (Math.random() < 0.5 ? a : b);
    const results = await Promise.all(
      Array.from({ length: 15 }, () => resolveRoomEndpoint(room, lease, registry, pick)),
    );

    const distinctUrls = new Set(results.map((r) => r.publicUrl));
    expect(distinctUrls.size).toBe(1);
  });

  it("throws when no live instance can be picked", async () => {
    const lease = new RoomLease(redis, 30);
    const registry = new InstanceRegistry(redis, { ttlSeconds: 30 });

    await expect(
      resolveRoomEndpoint(roomId(), lease, registry, async () => null),
    ).rejects.toBeInstanceOf(NoLiveInstanceError);
  });

  it("re-claims the room on a replacement instance if the recorded owner's heartbeat lapsed", async () => {
    const lease = new RoomLease(redis, 30);
    const registry = new InstanceRegistry(redis, { ttlSeconds: 30 });
    const room = roomId();
    const a = instanceId("a");
    const b = instanceId("b");

    // "a" claims the room, then its instance record disappears (crashed)
    // independently of the 30s room lease TTL.
    await registry.heartbeat({ instanceId: a, publicUrl: "http://a:4001" });
    const first = await resolveRoomEndpoint(room, lease, registry, async () => a);
    expect(first.instanceId).toBe(a);
    await registry.deregister(a);

    // "b" is the only live instance now; resolving again must converge on it,
    // not keep handing back "a"'s dead URL.
    await registry.heartbeat({ instanceId: b, publicUrl: "http://b:4001" });
    const second = await resolveRoomEndpoint(room, lease, registry, async () => b);
    expect(second).toEqual({ instanceId: b, publicUrl: "http://b:4001" });

    expect(await lease.currentOwner(room)).toBe(b);
  });
});
