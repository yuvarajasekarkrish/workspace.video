import { describe, it, expect, vi, afterEach } from "vitest";
import type { RoomLease } from "@cosmos/realtime-core";
import type { ObjectState } from "@cosmos/shared";
import { RoomManager, type RoomBroadcaster } from "../roomManager.js";
import type { ObjectRepository } from "../objectPersistence.js";

/** In-memory fake standing in for @cosmos/db's real object functions, so
 *  these tests never touch Postgres — matching fakeBroadcaster/fakeLease's
 *  role for their respective dependencies. */
function fakeObjectRepository(seed: ObjectState[] = []): ObjectRepository & {
  rows: Map<string, ObjectState>;
  upsertCalls: ObjectState[];
  deleteCalls: string[];
} {
  const rows = new Map(seed.map((o) => [o.objectId, o]));
  const upsertCalls: ObjectState[] = [];
  const deleteCalls: string[] = [];
  return {
    rows,
    upsertCalls,
    deleteCalls,
    loadRoomObjects: vi.fn(async (roomId: string) =>
      Array.from(rows.values()).filter((o) => o.roomId === roomId),
    ),
    upsertObject: vi.fn(async (state: ObjectState) => {
      upsertCalls.push(state);
      rows.set(state.objectId, state);
    }),
    deleteObject: vi.fn(async (objectId: string) => {
      deleteCalls.push(objectId);
      rows.delete(objectId);
    }),
  };
}

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
    createdById: "creator1",
    ...overrides,
  };
}

/** Records every emit so tests can assert on exactly what was broadcast,
 *  without spinning up a real Socket.IO server. */
function fakeBroadcaster() {
  const emitted: { target: string; event: string; payload: unknown }[] = [];
  const broadcaster: RoomBroadcaster = {
    to: (target) => ({
      emit: (event, payload) => emitted.push({ target, event, payload }),
    }),
    disconnectSocketsInRoom: vi.fn(),
  };
  return { broadcaster, emitted };
}

function fakeLease(refreshResult = true): RoomLease {
  return {
    refresh: vi.fn().mockResolvedValue(refreshResult),
    claimOrRead: vi.fn(),
    release: vi.fn(),
    currentOwner: vi.fn(),
  } as unknown as RoomLease;
}

describe("RoomManager", () => {
  // Every test assigns its RoomManager here so afterEach can explicitly
  // clear its tick/lease-refresh intervals via disposeAll() — ensureRoom
  // starts real setInterval timers, and leaving them running would keep
  // each test's timers alive until vitest tears down the whole worker
  // rather than being cleaned up by the test that created them.
  let activeManager: RoomManager | undefined;

  afterEach(async () => {
    await activeManager?.disposeAll();
    activeManager = undefined;
  });

  function createManager(...args: ConstructorParameters<typeof RoomManager>): RoomManager {
    activeManager = new RoomManager(...args);
    return activeManager;
  }

  it("delivers a snapshot reflecting every added peer", () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });
    rm.addPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2", position: { x: 10, y: 0 } });

    expect(rm.snapshot("room1")).toEqual([
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
      { userId: "u2", name: "Bo", avatarUrl: null, position: { x: 10, y: 0 } },
    ]);
  });

  it("rejects a move for a peer that isn't in the room", () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");

    expect(rm.applyMove("room1", "ghost", { x: 1, y: 1 })).toBeUndefined();
  });

  it("accepts a small move and rejects a teleport-speed move for the same peer", async () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });

    // Real elapsed time between moves, matching how a throttled client
    // actually behaves — validateMove's speed check is elapsed-time-aware,
    // so two calls back-to-back with ~0ms between them would (correctly)
    // reject even a small move; see packages/proximity/src/movement.ts.
    await new Promise((r) => setTimeout(r, 20));
    const small = rm.applyMove("room1", "u1", { x: 5, y: 0 });
    expect(small?.accepted).toBe(true);

    const teleport = rm.applyMove("room1", "u1", { x: 9000, y: 9000 });
    expect(teleport?.accepted).toBe(false);
  });

  it("tick emits a batched peers:delta only for peers whose position changed", async () => {
    const { broadcaster, emitted } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });
    rm.addPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2", position: { x: 500, y: 500 } });

    rm.runTickForTest("room1"); // first tick always reports every peer once
    emitted.length = 0;

    await new Promise((r) => setTimeout(r, 20)); // see movement-validator timing note above
    rm.applyMove("room1", "u1", { x: 5, y: 0 });
    rm.runTickForTest("room1");

    const deltas = emitted.filter((e) => e.event === "peers:delta");
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.payload).toEqual({
      roomId: "room1",
      updates: [{ userId: "u1", position: { x: 5, y: 0 } }],
      left: [],
    });
  });

  it("tick emits proximity:update to both peers' sockets when they come into range", () => {
    const { broadcaster, emitted } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });
    rm.addPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2", position: { x: 10, y: 0 } });

    rm.runTickForTest("room1");

    const proximityToS1 = emitted.find((e) => e.target === "s1" && e.event === "proximity:update");
    const proximityToS2 = emitted.find((e) => e.target === "s2" && e.event === "proximity:update");
    expect(proximityToS1?.payload).toMatchObject({ peerId: "u2", videoSubscribed: true });
    expect(proximityToS2?.payload).toMatchObject({ peerId: "u1", videoSubscribed: true });
  });

  it("re-emits proximity:update for a peer who rejoins at the same distance after leaving", async () => {
    // Regression test: without pruning proximityStates on removePeer, a
    // rejoining peer recomputes an identical state against the peer who
    // stayed, tickProximity's diff sees no change, and no fresh
    // proximity:update is ever sent to the rejoining peer's new socket.
    const { broadcaster, emitted } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });
    rm.addPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2", position: { x: 10, y: 0 } });
    rm.runTickForTest("room1"); // establishes the cached pair state

    await rm.removePeer("room1", "u2");
    // u2 rejoins with a new socket id but the exact same position relative to u1.
    rm.addPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2-new", position: { x: 10, y: 0 } });
    emitted.length = 0;

    rm.runTickForTest("room1");

    const proximityToNewSocket = emitted.find(
      (e) => e.target === "s2-new" && e.event === "proximity:update",
    );
    expect(proximityToNewSocket?.payload).toMatchObject({ peerId: "u1", videoSubscribed: true });
  });

  it("removePeer emits a left-list delta and evicts the room once empty", async () => {
    const { broadcaster, emitted } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });

    await rm.removePeer("room1", "u1");

    expect(emitted).toContainEqual({
      target: "room1",
      event: "peers:delta",
      payload: { roomId: "room1", updates: [], left: ["u1"] },
    });
    expect(rm.isOwnedLocally("room1")).toBe(false);
  });

  it("evicts the room and notifies clients when the lease refresh fails", async () => {
    // Fake timers scoped to this test only (and with real-time passthrough)
    // so setInterval fires deterministically without freezing Date.now(),
    // which RoomManager's movement validation elsewhere depends on.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { broadcaster, emitted } = fakeBroadcaster();
      const lease = fakeLease(false); // simulate having lost the lease
      const rm = createManager(broadcaster, lease, "instance-a", 100);
      rm.ensureRoom("room1");
      rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });

      await vi.advanceTimersByTimeAsync(150);

      expect(lease.refresh).toHaveBeenCalledWith("instance-a", "room1");
      expect(rm.isOwnedLocally("room1")).toBe(false);
      expect(emitted).toContainEqual({
        target: "room1",
        event: "owner:changed",
        payload: { roomId: "room1" },
      });
      expect(broadcaster.disconnectSocketsInRoom).toHaveBeenCalledWith("room1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("ensureRoom is idempotent — calling it twice does not reset room state", () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });

    rm.ensureRoom("room1");

    expect(rm.snapshot("room1")).toHaveLength(1);
  });

  it("disposeAll clears every room's timers so no interval outlives the manager", async () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.ensureRoom("room2");
    expect(rm.isOwnedLocally("room1")).toBe(true);
    expect(rm.isOwnedLocally("room2")).toBe(true);

    await rm.disposeAll();

    expect(rm.isOwnedLocally("room1")).toBe(false);
    expect(rm.isOwnedLocally("room2")).toBe(false);
  });

  describe("canvas objects", () => {
    it("hydrateObjects loads persisted objects into the room's in-memory state", async () => {
      const { broadcaster } = fakeBroadcaster();
      const persisted = makeObject();
      const repo = fakeObjectRepository([persisted]);
      const rm = createManager(broadcaster, fakeLease(), "instance-a", 10_000, repo);
      rm.ensureRoom("room1");

      await rm.hydrateObjects("room1");

      expect(rm.objectsSnapshot("room1")).toEqual([persisted]);
    });

    it("concurrent hydrateObjects calls for the same room share one load", async () => {
      const { broadcaster } = fakeBroadcaster();
      const repo = fakeObjectRepository([makeObject()]);
      const rm = createManager(broadcaster, fakeLease(), "instance-a", 10_000, repo);
      rm.ensureRoom("room1");

      await Promise.all([
        rm.hydrateObjects("room1"),
        rm.hydrateObjects("room1"),
        rm.hydrateObjects("room1"),
      ]);

      expect(repo.loadRoomObjects).toHaveBeenCalledTimes(1);
    });

    it("applyObjectUpsert accepts a create (baseVersion 0) and assigns version 1", async () => {
      const { broadcaster } = fakeBroadcaster();
      const repo = fakeObjectRepository();
      const rm = createManager(broadcaster, fakeLease(), "instance-a", 10_000, repo);
      rm.ensureRoom("room1");
      await rm.hydrateObjects("room1");

      const result = rm.applyObjectUpsert("room1", "u1", {
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
        baseVersion: 0,
      });

      expect(result?.accepted).toBe(true);
      if (result?.accepted) {
        expect(result.next.version).toBe(1);
        expect(result.next.createdById).toBe("u1");
      }
      expect(rm.objectsSnapshot("room1")).toHaveLength(1);
    });

    it("applyObjectUpsert increments version on a matching-baseVersion edit", async () => {
      const { broadcaster } = fakeBroadcaster();
      const repo = fakeObjectRepository([makeObject({ version: 1 })]);
      const rm = createManager(broadcaster, fakeLease(), "instance-a", 10_000, repo);
      rm.ensureRoom("room1");
      await rm.hydrateObjects("room1");

      const result = rm.applyObjectUpsert("room1", "u1", {
        objectId: "obj1",
        roomId: "room1",
        type: "note",
        x: 50,
        y: 50,
        width: 100,
        height: 100,
        rotation: 0,
        z: 0,
        data: {},
        baseVersion: 1,
      });

      expect(result?.accepted).toBe(true);
      if (result?.accepted) expect(result.next.version).toBe(2);
    });

    it("applyObjectUpsert rejects a stale baseVersion and returns the authoritative state", async () => {
      const { broadcaster } = fakeBroadcaster();
      const repo = fakeObjectRepository([makeObject({ version: 5 })]);
      const rm = createManager(broadcaster, fakeLease(), "instance-a", 10_000, repo);
      rm.ensureRoom("room1");
      await rm.hydrateObjects("room1");

      const result = rm.applyObjectUpsert("room1", "u1", {
        objectId: "obj1",
        roomId: "room1",
        type: "note",
        x: 1,
        y: 1,
        width: 100,
        height: 100,
        rotation: 0,
        z: 0,
        data: {},
        baseVersion: 3, // stale
      });

      expect(result?.accepted).toBe(false);
      if (!result?.accepted) {
        expect(result?.reason).toBe("stale_version");
        expect(result?.authoritative?.version).toBe(5);
      }
      // The rejected write must not have mutated room state.
      expect(rm.objectsSnapshot("room1")[0]?.version).toBe(5);
    });

    it("applyObjectDelete succeeds for the creator and fails for a different user", async () => {
      const { broadcaster } = fakeBroadcaster();
      const repo = fakeObjectRepository([makeObject({ createdById: "creator1", version: 1 })]);
      const rm = createManager(broadcaster, fakeLease(), "instance-a", 10_000, repo);
      rm.ensureRoom("room1");
      await rm.hydrateObjects("room1");

      const deniedForNonCreator = rm.applyObjectDelete("room1", "someone-else", "obj1", 1);
      expect(deniedForNonCreator?.outcome).toBe("rejected");
      expect(rm.objectsSnapshot("room1")).toHaveLength(1); // still present

      const allowedForCreator = rm.applyObjectDelete("room1", "creator1", "obj1", 1);
      expect(allowedForCreator?.outcome).toBe("deleted");
      expect(rm.objectsSnapshot("room1")).toHaveLength(0);
    });

    it("hydration completes before a mutation is applied, so a create doesn't get clobbered by a slow load", async () => {
      const { broadcaster } = fakeBroadcaster();
      const repo = fakeObjectRepository();
      // Make the load resolve on a later tick, simulating real async latency —
      // a mutation handler that didn't await hydrateObjects() first could
      // apply against an empty map and then have the load silently overwrite it.
      let resolveLoad!: () => void;
      repo.loadRoomObjects = vi.fn(
        () => new Promise<ObjectState[]>((resolve) => (resolveLoad = () => resolve([]))),
      );
      const rm = createManager(broadcaster, fakeLease(), "instance-a", 10_000, repo);
      rm.ensureRoom("room1");

      const hydration = rm.hydrateObjects("room1");
      resolveLoad();
      await hydration;

      const result = rm.applyObjectUpsert("room1", "u1", {
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
        baseVersion: 0,
      });

      expect(result?.accepted).toBe(true);
      expect(rm.objectsSnapshot("room1")).toHaveLength(1);
    });

    it("evicting a room flushes pending object writes before dropping state", async () => {
      const { broadcaster } = fakeBroadcaster();
      const repo = fakeObjectRepository();
      const rm = createManager(broadcaster, fakeLease(), "instance-a", 10_000, repo);
      rm.ensureRoom("room1");
      await rm.hydrateObjects("room1");
      rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });

      rm.applyObjectUpsert("room1", "u1", {
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
        baseVersion: 0,
      });

      // Last peer leaves — this evicts the room, which must flush the
      // just-created object to the repository before the eviction resolves.
      await rm.removePeer("room1", "u1");

      expect(repo.upsertCalls).toHaveLength(1);
      expect(repo.upsertCalls[0]!.objectId).toBe("obj1");
    });
  });
});
