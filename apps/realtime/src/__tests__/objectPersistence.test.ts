import { describe, it, expect, vi, afterEach } from "vitest";
import type { ObjectState } from "@workspace-video/shared";
import { ObjectPersistence, type ObjectRepository } from "../objectPersistence";

function makeObject(overrides: Partial<ObjectState> = {}): ObjectState {
  return {
    objectId: "obj1",
    roomId: "room1",
    type: "note",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    z: 0,
    data: {},
    version: 1,
    createdById: "u1",
    ...overrides,
  };
}

function fakeRepository(): ObjectRepository & {
  upsertCalls: ObjectState[];
  deleteCalls: string[];
} {
  const upsertCalls: ObjectState[] = [];
  const deleteCalls: string[] = [];
  return {
    upsertCalls,
    deleteCalls,
    loadRoomObjects: vi.fn().mockResolvedValue([]),
    upsertObject: vi.fn(async (state: ObjectState) => {
      upsertCalls.push(state);
    }),
    deleteObject: vi.fn(async (objectId: string) => {
      deleteCalls.push(objectId);
    }),
  };
}

describe("ObjectPersistence", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("markDirty schedules a flush that reads the CURRENT value, not the value at markDirty-time", async () => {
    vi.useFakeTimers();
    const repo = fakeRepository();
    let liveState = makeObject({ x: 0 });
    const persistence = new ObjectPersistence(repo, () => liveState, 1000);

    persistence.markDirty("room1", "obj1");
    liveState = { ...liveState, x: 999, version: 2 }; // changes again before the debounce fires

    await vi.advanceTimersByTimeAsync(1000);

    expect(repo.upsertCalls).toHaveLength(1);
    expect(repo.upsertCalls[0]!.x).toBe(999); // the fresh value, not the stale x:0
  });

  it("N rapid dirty marks for the same object collapse into exactly one write", async () => {
    vi.useFakeTimers();
    const repo = fakeRepository();
    const state = makeObject();
    const persistence = new ObjectPersistence(repo, () => state, 1000);

    for (let i = 0; i < 200; i++) {
      persistence.markDirty("room1", "obj1");
    }

    expect(repo.upsertCalls).toHaveLength(0); // not flushed yet — timer keeps getting reused, not re-armed
    await vi.advanceTimersByTimeAsync(1000);
    expect(repo.upsertCalls).toHaveLength(1);
  });

  it("does not schedule a second timer while one is already pending for a room", async () => {
    vi.useFakeTimers();
    const repo = fakeRepository();
    const persistence = new ObjectPersistence(repo, () => makeObject(), 1000);

    persistence.markDirty("room1", "obj1");
    expect(persistence.hasPendingFlush("room1")).toBe(true);
    persistence.markDirty("room1", "obj2");
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(persistence.hasPendingFlush("room1")).toBe(false);
  });

  it("a delete queued after a dirty mark for the same object cancels the pending upsert", async () => {
    vi.useFakeTimers();
    const repo = fakeRepository();
    const persistence = new ObjectPersistence(repo, () => makeObject(), 1000);

    persistence.markDirty("room1", "obj1");
    persistence.markDeleted("room1", "obj1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(repo.upsertCalls).toHaveLength(0);
    expect(repo.deleteCalls).toEqual(["obj1"]);
  });

  it("an upsert queued after a delete for the same object cancels the pending delete", async () => {
    vi.useFakeTimers();
    const repo = fakeRepository();
    const persistence = new ObjectPersistence(repo, () => makeObject(), 1000);

    persistence.markDeleted("room1", "obj1");
    persistence.markDirty("room1", "obj1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(repo.deleteCalls).toHaveLength(0);
    expect(repo.upsertCalls).toHaveLength(1);
  });

  it("flushAndClear cancels the pending timer and flushes immediately (used on room eviction)", async () => {
    vi.useFakeTimers();
    const repo = fakeRepository();
    const persistence = new ObjectPersistence(repo, () => makeObject(), 60_000); // long debounce

    persistence.markDirty("room1", "obj1");
    expect(persistence.hasPendingFlush("room1")).toBe(true);

    await persistence.flushAndClear("room1");

    expect(repo.upsertCalls).toHaveLength(1);
    expect(persistence.hasPendingFlush("room1")).toBe(false);
    // Advancing the full debounce window afterward must not double-flush.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(repo.upsertCalls).toHaveLength(1);
  });

  it("flushAllAndDispose flushes every dirty room and clears every timer, so none outlives it", async () => {
    vi.useFakeTimers();
    const repo = fakeRepository();
    const objects: Record<string, ObjectState> = {
      "room1:obj1": makeObject({ objectId: "obj1", roomId: "room1" }),
      "room2:obj2": makeObject({ objectId: "obj2", roomId: "room2" }),
    };
    const persistence = new ObjectPersistence(
      repo,
      (roomId, objectId) => objects[`${roomId}:${objectId}`],
      60_000,
    );

    persistence.markDirty("room1", "obj1");
    persistence.markDirty("room2", "obj2");
    expect(vi.getTimerCount()).toBe(2);

    await persistence.flushAllAndDispose();

    expect(repo.upsertCalls).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
    expect(persistence.hasPendingFlush("room1")).toBe(false);
    expect(persistence.hasPendingFlush("room2")).toBe(false);
  });

  it("skips the write entirely if the object is gone by the time the flush runs", async () => {
    vi.useFakeTimers();
    const repo = fakeRepository();
    const persistence = new ObjectPersistence(repo, () => undefined, 1000); // "gone" - room/object no longer resolvable

    persistence.markDirty("room1", "obj1");
    await vi.advanceTimersByTimeAsync(1000);

    expect(repo.upsertCalls).toHaveLength(0);
  });
});
