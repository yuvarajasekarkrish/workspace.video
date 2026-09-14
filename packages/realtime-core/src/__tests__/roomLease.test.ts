import { describe, it, expect, afterAll } from "vitest";
import { Redis } from "ioredis";
import { RoomLease } from "../roomLease.js";

// Integration tests against a real local Redis (docker-compose), not a mock —
// the whole point of this module is atomicity guarantees Redis provides that
// a fake client could accidentally "pass" without actually proving anything.
const redis = new Redis(process.env.REDIS_URL ?? "redis://localhost:6379");

afterAll(async () => {
  await redis.quit();
});

describe("RoomLease", () => {
  // Vitest runs test files in parallel workers, and this suite intentionally
  // hits a real shared Redis rather than a mock (see comment above), so tests
  // must not share state via a global flushdb — a sibling file's flushdb
  // would wipe keys this file has in flight. Randomized ids per test give
  // each test its own isolated keyspace instead.
  const roomId = () => `test-room-${crypto.randomUUID()}`;

  it("claims an unowned room for the candidate", async () => {
    const lease = new RoomLease(redis, 30);
    const room = roomId();
    const owner = await lease.claimOrRead("instance-a", room);
    expect(owner).toBe("instance-a");
  });

  it("a second caller reads back the first owner instead of overwriting it", async () => {
    const lease = new RoomLease(redis, 30);
    const room = roomId();
    const first = await lease.claimOrRead("instance-a", room);
    const second = await lease.claimOrRead("instance-b", room);
    expect(first).toBe("instance-a");
    expect(second).toBe("instance-a");
  });

  it("many concurrent claims for the same unowned room all converge on one owner", async () => {
    const lease = new RoomLease(redis, 30);
    const room = roomId();
    const candidates = Array.from({ length: 20 }, (_, i) => `instance-${i}`);

    const results = await Promise.all(
      candidates.map((id) => lease.claimOrRead(id, room)),
    );

    const distinctOwners = new Set(results);
    expect(distinctOwners.size).toBe(1);
    // The winning owner must be one of the actual candidates.
    expect(candidates).toContain([...distinctOwners][0]);
  });

  it("only the current owner can refresh the lease", async () => {
    const lease = new RoomLease(redis, 30);
    const room = roomId();
    await lease.claimOrRead("instance-a", room);

    const ownerRefresh = await lease.refresh("instance-a", room);
    const impostorRefresh = await lease.refresh("instance-b", room);

    expect(ownerRefresh).toBe(true);
    expect(impostorRefresh).toBe(false);
  });

  it("only the current owner can release the lease", async () => {
    const lease = new RoomLease(redis, 30);
    const room = roomId();
    await lease.claimOrRead("instance-a", room);

    const impostorRelease = await lease.release("instance-b", room);
    expect(impostorRelease).toBe(false);
    expect(await lease.currentOwner(room)).toBe("instance-a");

    const ownerRelease = await lease.release("instance-a", room);
    expect(ownerRelease).toBe(true);
    expect(await lease.currentOwner(room)).toBeNull();
  });

  it("a released room can be claimed by a new owner", async () => {
    const lease = new RoomLease(redis, 30);
    const room = roomId();
    await lease.claimOrRead("instance-a", room);
    await lease.release("instance-a", room);

    const newOwner = await lease.claimOrRead("instance-b", room);
    expect(newOwner).toBe("instance-b");
  });

  it("an expired lease (short TTL) can be reclaimed by a different instance", async () => {
    const lease = new RoomLease(redis, 1); // 1 second TTL
    const room = roomId();
    await lease.claimOrRead("instance-a", room);

    await new Promise((r) => setTimeout(r, 1300));

    const newOwner = await lease.claimOrRead("instance-b", room);
    expect(newOwner).toBe("instance-b");
  });
});
