import { describe, it, expect, afterAll } from "vitest";
import { Redis } from "ioredis";
import { InstanceRegistry } from "../instanceRegistry.js";

const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

afterAll(async () => {
  await redis.quit();
});

describe("InstanceRegistry", () => {
  const id = (label: string) => `${label}-${crypto.randomUUID()}`;

  it("lists an instance as active right after heartbeat", async () => {
    const registry = new InstanceRegistry(redis, { ttlSeconds: 30 });
    const a = id("a");
    await registry.heartbeat({ instanceId: a, publicUrl: "http://a:4001" });

    expect(await registry.listActiveIds()).toContain(a);
  });

  it("prunes an instance from the active list once its TTL key expires", async () => {
    const registry = new InstanceRegistry(redis, { ttlSeconds: 1 });
    const a = id("a");
    await registry.heartbeat({ instanceId: a, publicUrl: "http://a:4001" });
    expect(await registry.listActiveIds()).toContain(a);

    await new Promise((r) => setTimeout(r, 1300));

    const active = await registry.listActiveIds();
    expect(active).not.toContain(a);
    // get() must independently agree it's gone (the TTL key, not just the set).
    expect(await registry.get(a)).toBeNull();
  });

  it("removes an instance from the active list on deregister", async () => {
    const registry = new InstanceRegistry(redis, { ttlSeconds: 30 });
    const a = id("a");
    await registry.heartbeat({ instanceId: a, publicUrl: "http://a:4001" });
    await registry.deregister(a);

    expect(await registry.listActiveIds()).not.toContain(a);
  });
});
