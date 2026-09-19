import { describe, it, expect, vi, afterEach } from "vitest";
import type { RoomLease } from "@cosmos/realtime-core";
import { openOffice1, type ObjectState } from "@cosmos/shared";
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

function fakeLease(refreshResult: "renewed" | "reclaimed" | "lost" = "renewed"): RoomLease {
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
    rm.ensureRoom("room1", "ws1");
    rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);
    rm.admitAndAddPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2", position: { x: 10, y: 0 } }, 100);

    expect(rm.snapshot("room1")).toEqual([
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
      { userId: "u2", name: "Bo", avatarUrl: null, position: { x: 10, y: 0 } },
    ]);
  });

  it("rejects a move for a peer that isn't in the room", () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1", "ws1");

    expect(rm.applyMove("room1", "ghost", { x: 1, y: 1 })).toBeUndefined();
  });

  it("accepts a small move and rejects a teleport-speed move for the same peer", async () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1", "ws1");
    rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);

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
    rm.ensureRoom("room1", "ws1");
    rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);
    rm.admitAndAddPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2", position: { x: 500, y: 500 } }, 100);

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
    rm.ensureRoom("room1", "ws1");
    rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);
    rm.admitAndAddPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2", position: { x: 10, y: 0 } }, 100);

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
    rm.ensureRoom("room1", "ws1");
    rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);
    rm.admitAndAddPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2", position: { x: 10, y: 0 } }, 100);
    rm.runTickForTest("room1"); // establishes the cached pair state

    await rm.removePeer("room1", "u2");
    // u2 rejoins with a new socket id but the exact same position relative to u1.
    rm.admitAndAddPeer("room1", { userId: "u2", name: "Bo", avatarUrl: null, socketId: "s2-new", position: { x: 10, y: 0 } }, 100);
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
    rm.ensureRoom("room1", "ws1");
    rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);

    await rm.removePeer("room1", "u1");

    expect(emitted).toContainEqual({
      target: "room1",
      event: "peers:delta",
      payload: { roomId: "room1", updates: [], left: ["u1"] },
    });
    expect(rm.isOwnedLocally("room1")).toBe(false);
  });

  it("evicts the room and notifies clients when the lease is genuinely lost", async () => {
    // Fake timers scoped to this test only (and with real-time passthrough)
    // so setInterval fires deterministically without freezing Date.now(),
    // which RoomManager's movement validation elsewhere depends on.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { broadcaster, emitted } = fakeBroadcaster();
      const lease = fakeLease("lost"); // a different instance now holds the key
      const rm = createManager(broadcaster, lease, "instance-a", 100);
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);

      await vi.advanceTimersByTimeAsync(150);

      expect(lease.refresh).toHaveBeenCalledWith("instance-a", "room1");
      expect(rm.isOwnedLocally("room1")).toBe(false);
      expect(emitted).toContainEqual({
        target: "room1",
        event: "owner:changed",
        payload: { roomId: "room1" },
      });
      expect(broadcaster.disconnectSocketsInRoom).toHaveBeenCalledWith("room1");
      expect(rm.getLeaseStats().lost).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT evict the room when the lease was merely reclaimed (no competing owner)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { broadcaster, emitted } = fakeBroadcaster();
      const lease = fakeLease("reclaimed"); // key expired, but nobody else claimed it
      const rm = createManager(broadcaster, lease, "instance-a", 100);
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);

      await vi.advanceTimersByTimeAsync(150);

      expect(lease.refresh).toHaveBeenCalledWith("instance-a", "room1");
      expect(rm.isOwnedLocally("room1")).toBe(true);
      expect(emitted).not.toContainEqual(expect.objectContaining({ event: "owner:changed" }));
      expect(broadcaster.disconnectSocketsInRoom).not.toHaveBeenCalled();
      expect(rm.getLeaseStats().reclaimed).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT evict and does not reject when refresh throws", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { broadcaster, emitted } = fakeBroadcaster();
      const lease: RoomLease = {
        refresh: vi.fn().mockRejectedValue(new Error("ECONNRESET")),
        claimOrRead: vi.fn(),
        release: vi.fn(),
        currentOwner: vi.fn(),
      } as unknown as RoomLease;
      const rm = createManager(broadcaster, lease, "instance-a", 100);
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);

      await vi.advanceTimersByTimeAsync(150);

      expect(rm.isOwnedLocally("room1")).toBe(true);
      expect(emitted).not.toContainEqual(expect.objectContaining({ event: "owner:changed" }));
      expect(broadcaster.disconnectSocketsInRoom).not.toHaveBeenCalled();
      expect(rm.getLeaseStats().errors).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not overlap refreshes when a refresh call is slow", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { broadcaster } = fakeBroadcaster();
      let concurrentCalls = 0;
      let maxConcurrent = 0;
      const lease: RoomLease = {
        refresh: vi.fn().mockImplementation(async () => {
          concurrentCalls++;
          maxConcurrent = Math.max(maxConcurrent, concurrentCalls);
          await new Promise((resolve) => setTimeout(resolve, 120)); // slower than the 100ms interval
          concurrentCalls--;
          return "renewed";
        }),
        claimOrRead: vi.fn(),
        release: vi.fn(),
        currentOwner: vi.fn(),
      } as unknown as RoomLease;
      const rm = createManager(broadcaster, lease, "instance-a", 100);
      rm.ensureRoom("room1", "ws1");

      await vi.advanceTimersByTimeAsync(350);

      expect(maxConcurrent).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ensureRoom is idempotent — calling it twice does not reset room state", () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1", "ws1");
    rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);

    rm.ensureRoom("room1", "ws1");

    expect(rm.snapshot("room1")).toHaveLength(1);
  });

  it("disposeAll clears every room's timers so no interval outlives the manager", async () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1", "ws1");
    rm.ensureRoom("room2", "ws1");
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
      rm.ensureRoom("room1", "ws1");

      await rm.hydrateObjects("room1");

      expect(rm.objectsSnapshot("room1")).toEqual([persisted]);
    });

    it("concurrent hydrateObjects calls for the same room share one load", async () => {
      const { broadcaster } = fakeBroadcaster();
      const repo = fakeObjectRepository([makeObject()]);
      const rm = createManager(broadcaster, fakeLease(), "instance-a", 10_000, repo);
      rm.ensureRoom("room1", "ws1");

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
      rm.ensureRoom("room1", "ws1");
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
      rm.ensureRoom("room1", "ws1");
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
      rm.ensureRoom("room1", "ws1");
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
      rm.ensureRoom("room1", "ws1");
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
      rm.ensureRoom("room1", "ws1");

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
      rm.ensureRoom("room1", "ws1");
      await rm.hydrateObjects("room1");
      rm.admitAndAddPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } }, 100);

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

  describe("participant limits", () => {
    function peer(userId: string, socketId = `s-${userId}`) {
      return { userId, name: userId, avatarUrl: null, socketId, position: { x: 0, y: 0 } };
    }

    it("admits up to the limit and rejects the next distinct user", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");

      for (let i = 0; i < 10; i++) {
        expect(rm.admitAndAddPeer("room1", peer(`u${i}`), 10)).toEqual({ admitted: true });
      }

      const result = rm.admitAndAddPeer("room1", peer("u10"), 10);
      expect(result).toEqual({ admitted: false, reason: "workspace_full", limit: 10, active: 10 });
      // The rejected join must not have mutated room state.
      expect(rm.snapshot("room1")).toHaveLength(10);
    });

    it("readmits an already-active user (reconnect/second tab) without increasing the count", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 1);

      const result = rm.admitAndAddPeer("room1", peer("u1", "s-u1-new"), 1);

      expect(result).toEqual({ admitted: true });
      expect(rm.snapshot("room1")).toHaveLength(1);
      expect(rm.snapshot("room1")[0]!.userId).toBe("u1");
    });

    it("a leaving user frees a slot for the next join", async () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 1);
      expect(rm.admitAndAddPeer("room1", peer("u2"), 1).admitted).toBe(false);

      await rm.removePeer("room1", "u1");
      rm.ensureRoom("room1", "ws1"); // removePeer evicted the (now-empty) room

      expect(rm.admitAndAddPeer("room1", peer("u2"), 1)).toEqual({ admitted: true });
    });

    it("counts active users across every room owned for the same workspace", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.ensureRoom("room2", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 2);
      rm.admitAndAddPeer("room2", peer("u2"), 2);

      expect(rm.activeUserIds("ws1")).toEqual(new Set(["u1", "u2"]));
      // The limit is workspace-wide, so the 3rd distinct user is rejected
      // even though room2 individually only holds one peer so far.
      expect(rm.admitAndAddPeer("room2", peer("u3"), 2).admitted).toBe(false);
    });

    it("broadcasts occupancy:update on admit and on leave", async () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");

      rm.admitAndAddPeer("room1", peer("u1"), 5);
      expect(emitted).toContainEqual({
        target: "room1",
        event: "occupancy:update",
        payload: { roomId: "room1", active: 1, limit: 5 },
      });

      rm.admitAndAddPeer("room1", peer("u2"), 5);
      emitted.length = 0;
      await rm.removePeer("room1", "u1");

      expect(emitted).toContainEqual({
        target: "room1",
        event: "occupancy:update",
        payload: { roomId: "room1", active: 1, limit: 5 },
      });
    });

    it("occupancy() reports zeros for a room that doesn't exist", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      expect(rm.occupancy("ghost-room")).toEqual({ active: 0, limit: 0 });
    });

    it("two simultaneous admits at the last slot admit exactly one", () => {
      // admitAndAddPeer is synchronous end-to-end (no await between the
      // capacity check and inserting the peer), so calling it twice back to
      // back — simulating two sockets racing for the last slot — can never
      // admit both, unlike an async check-then-insert would.
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 2); // fills one of two slots

      const resultA = rm.admitAndAddPeer("room1", peer("u2"), 2);
      const resultB = rm.admitAndAddPeer("room1", peer("u3"), 2);

      const admittedCount = [resultA, resultB].filter((r) => r.admitted).length;
      expect(admittedCount).toBe(1);
      expect(rm.snapshot("room1")).toHaveLength(2);
    });

    it("a fake ParticipantLimitProvider changes admission with no change to RoomManager", () => {
      // Demonstrates the abstraction's whole point: the limit is resolved
      // externally (server.ts, via a ParticipantLimitProvider) and simply
      // passed in — RoomManager has no knowledge of where it came from.
      const fakeProvider = { getWorkspaceParticipantLimit: async (_workspaceId: string) => 1 };
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");

      return fakeProvider.getWorkspaceParticipantLimit("ws1").then((limit) => {
        rm.admitAndAddPeer("room1", peer("u1"), limit);
        expect(rm.admitAndAddPeer("room1", peer("u2"), limit).admitted).toBe(false);
      });
    });
  });

  describe("hot-desk seating", () => {
    // The two chairs at "Desk 1" — close enough together (well within the
    // seat claim radius) to exercise re-seating without also having to
    // simulate walking across the room between claims.
    const desk1Seats = openOffice1.seats.filter((s) => s.label === "Desk 1");
    const seat = desk1Seats[0]!;
    const otherSeat = desk1Seats[1]!;

    function peer(userId: string, position = seat.anchor, socketId = `s-${userId}`) {
      return { userId, name: userId, avatarUrl: null, socketId, position };
    }

    it("claiming a seat sets acceptedAtMs to the claim time, not stale from admission", () => {
      // Fake timers make the distinguishing scenario reproducible: without
      // resetting acceptedAtMs at claim time (the bug the plan calls out),
      // a move sent long after admission but shortly after claiming would
      // compute its elapsed time from the STALE admission timestamp —
      // 10+ real seconds, i.e. a huge speed allowance — and incorrectly
      // ACCEPT a large jump. With acceptedAtMs correctly refreshed at
      // claim time, the same move's elapsed time is ~0 and it is REJECTED.
      vi.useFakeTimers();
      try {
        const { broadcaster } = fakeBroadcaster();
        const rm = createManager(broadcaster, fakeLease(), "instance-a");
        rm.ensureRoom("room1", "ws1");
        rm.admitAndAddPeer("room1", peer("u1"), 100); // acceptedAtMs = t0

        vi.advanceTimersByTime(10_000); // far enough that a stale window would allow almost anything
        const result = rm.claimSeat("room1", "u1", seat.id); // should reset acceptedAtMs to t0+10000
        expect(result).toEqual({ accepted: true, seatId: seat.id, previousSeatId: null });

        vi.advanceTimersByTime(10); // negligible elapsed since the claim
        const bigJump = rm.applyMove("room1", "u1", { x: seat.anchor.x + 5000, y: seat.anchor.y });
        expect(bigJump?.accepted).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it("rejects claiming an unknown seat", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 100);

      expect(rm.claimSeat("room1", "u1", "no-such-seat")).toEqual({
        accepted: false,
        reason: "unknown_seat",
      });
    });

    it("rejects claiming a seat someone else already occupies", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 100);
      rm.admitAndAddPeer("room1", peer("u2"), 100);

      expect(rm.claimSeat("room1", "u1", seat.id)!.accepted).toBe(true);
      expect(rm.claimSeat("room1", "u2", seat.id)).toEqual({ accepted: false, reason: "occupied" });
    });

    it("rejects a claim from outside the seat's claim radius", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      // Far from every seat in the layout.
      rm.admitAndAddPeer("room1", peer("u1", { x: seat.anchor.x + 1000, y: seat.anchor.y + 1000 }), 100);

      expect(rm.claimSeat("room1", "u1", seat.id)).toEqual({ accepted: false, reason: "out_of_range" });
    });

    it("re-seating releases the previous seat and broadcasts both updates", () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 100);
      rm.claimSeat("room1", "u1", seat.id);

      // The peer is now physically AT `seat.anchor` (the teleport), so a
      // claim on `otherSeat` only succeeds if it's also within range from
      // there — the fixture's two seats are the same desk's two chairs,
      // well within the claim radius of each other.
      emitted.length = 0;
      const result = rm.claimSeat("room1", "u1", otherSeat.id);

      expect(result).toEqual({ accepted: true, seatId: otherSeat.id, previousSeatId: seat.id });
      expect(emitted).toContainEqual({
        target: "room1",
        event: "seat:update",
        payload: { seatId: seat.id, userId: null },
      });
      expect(emitted).toContainEqual({
        target: "room1",
        event: "seat:update",
        payload: { seatId: otherSeat.id, userId: "u1" },
      });
    });

    it("removePeer frees the seat while other peers remain in the room", async () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 100);
      rm.admitAndAddPeer("room1", peer("u2", otherSeat.anchor), 100);
      rm.claimSeat("room1", "u1", seat.id);

      emitted.length = 0;
      await rm.removePeer("room1", "u1");

      expect(emitted).toContainEqual({
        target: "room1",
        event: "seat:update",
        payload: { seatId: seat.id, userId: null },
      });
      expect(rm.seatsSnapshot("room1")).toEqual([]);
      // The leak case this test guards against: evictRoom only runs when the
      // room is EMPTY, which it is not here (u2 remains) — so if removePeer
      // didn't release unconditionally, this seat would stay occupied
      // indefinitely.
      expect(rm.isOwnedLocally("room1")).toBe(true);
    });

    it("a move from a seated peer implicitly releases the seat", () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 100);
      rm.claimSeat("room1", "u1", seat.id);

      emitted.length = 0;
      rm.applyMove("room1", "u1", { x: seat.anchor.x + 10, y: seat.anchor.y });

      expect(emitted).toContainEqual({
        target: "room1",
        event: "seat:update",
        payload: { seatId: seat.id, userId: null },
      });
      expect(rm.seatsSnapshot("room1")).toEqual([]);
    });

    it("seat:release is idempotent — releasing twice (or with no seat held) is a harmless no-op", () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 100);
      rm.claimSeat("room1", "u1", seat.id);

      rm.releaseSeat("room1", "u1");
      emitted.length = 0;
      // Second release (simulating move-then-release ordering, or a
      // duplicate client emit) must not broadcast a second seat:update.
      rm.releaseSeat("room1", "u1");

      expect(emitted).toEqual([]);
    });

    it("seatsSnapshot reflects current occupancy for a joining client", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1"), 100);
      rm.claimSeat("room1", "u1", seat.id);

      expect(rm.seatsSnapshot("room1")).toEqual([{ seatId: seat.id, userId: "u1" }]);
    });
  });

  describe("zone audio", () => {
    // "no zone" reference area: openOffice1's desk grid (col0-2,row3-8) has
    // no covering LayoutZone. Meeting Room A is col0-3,row0-2 -> world px
    // x:[0,640), y:[0,480).
    const OUTSIDE_A = { x: 50, y: 600 };
    const OUTSIDE_B = { x: 50, y: 1200 }; // 600px from OUTSIDE_A — beyond audioRadius (500)
    const INSIDE_MEETING_A = { x: 10, y: 100 };
    const INSIDE_MEETING_B = { x: 610, y: 100 }; // 600px from INSIDE_MEETING_A — SAME distance as outside
    const JUST_OUTSIDE_HYSTERESIS_A = { x: 50, y: 600 };
    const JUST_OUTSIDE_HYSTERESIS_B = { x: 50, y: 1110 }; // 510px — inside audioRadius+hysteresis (525) but outside audioRadius (500)

    function peer(userId: string, position: { x: number; y: number }, socketId = `s-${userId}`) {
      return { userId, name: userId, avatarUrl: null, socketId, position };
    }

    it("a zone crossing between two people at a CONSTANT pairwise distance still emits — tickProximity alone would report no change", () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1", OUTSIDE_A), 100);
      rm.admitAndAddPeer("room1", peer("u2", OUTSIDE_B), 100);
      rm.runTickForTest("room1"); // caches raw NOT_NEARBY (600px > audioRadius 500) for this pair

      // Move BOTH into Meeting Room A, preserving the exact 600px separation
      // — tickProximity will see an IDENTICAL distance and report this pair
      // as unchanged. Only the zone diff can catch this crossing.
      emitted.length = 0;
      rm.admitAndAddPeer("room1", peer("u1", INSIDE_MEETING_A), 100);
      rm.admitAndAddPeer("room1", peer("u2", INSIDE_MEETING_B), 100);
      rm.runTickForTest("room1");

      const audioToU1 = emitted.find((e) => e.target === "s-u1" && e.event === "proximity:update");
      const audioToU2 = emitted.find((e) => e.target === "s-u2" && e.event === "proximity:update");
      expect(audioToU1?.payload).toMatchObject({ peerId: "u2", audioSubscribed: true, audioGain: 1 });
      expect(audioToU2?.payload).toMatchObject({ peerId: "u1", audioSubscribed: true, audioGain: 1 });
    });

    it("emits zone:changed to a peer's own socket when they cross a zone boundary", () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1", OUTSIDE_A), 100);
      rm.runTickForTest("room1");

      emitted.length = 0;
      rm.admitAndAddPeer("room1", peer("u1", INSIDE_MEETING_A), 100);
      rm.runTickForTest("room1");

      const zoneChanged = emitted.find((e) => e.target === "s-u1" && e.event === "zone:changed");
      expect(zoneChanged?.payload).toMatchObject({ zone: { label: "Meeting Room A", kind: "meeting" } });
    });

    it("a zone override never mutates the RAW cached proximity state, and leaving leaves no phantom hysteresis", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1", OUTSIDE_A), 100);
      rm.admitAndAddPeer("room1", peer("u2", OUTSIDE_B), 100);
      rm.runTickForTest("room1");

      rm.admitAndAddPeer("room1", peer("u1", INSIDE_MEETING_A), 100);
      rm.admitAndAddPeer("room1", peer("u2", INSIDE_MEETING_B), 100);
      rm.runTickForTest("room1");

      // The zone override made both sides hear full gain (asserted in the
      // sibling test above), but the RAW cache underneath must still show
      // the true, un-overridden distance-based state — otherwise the next
      // hysteresis calculation reads a corrupted "wasAudio" baseline. Phase
      // 9's sparse tracker never stores a NOT_NEARBY pair at all (see
      // SparseProximityTracker's docs), so "undefined" here IS the honest,
      // un-corrupted raw state for a genuinely-600px-apart pair — not a
      // missing value.
      const rawInMeeting = rm.proximityStateForTest("room1", "u1", "u2");
      expect(rawInMeeting?.audioSubscribed ?? false).toBe(false); // 600px apart is genuinely NOT_NEARBY

      // Move both to a distance BETWEEN audioRadius (500) and
      // audioRadius+hysteresis (525) — 510px. If the raw cache had been
      // corrupted to wasAudio=true by the earlier override, this distance
      // would incorrectly stay "subscribed" (a phantom hysteresis band it
      // never earned). With the cache honestly still `false`, it correctly
      // stays unsubscribed.
      rm.admitAndAddPeer("room1", peer("u1", JUST_OUTSIDE_HYSTERESIS_A), 100);
      rm.admitAndAddPeer("room1", peer("u2", JUST_OUTSIDE_HYSTERESIS_B), 100);
      rm.runTickForTest("room1");

      const rawAfterExit = rm.proximityStateForTest("room1", "u1", "u2");
      expect(rawAfterExit?.audioSubscribed ?? false).toBe(false);
    });

    it("zoneOf is pruned on removePeer — a rejoining user in the SAME zone is treated as a fresh entry", async () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      // u2 stays in the room throughout so removePeer("u1") doesn't evict
      // the whole room (which would otherwise wipe zoneOf for a different,
      // uninteresting reason) — isolating the actual pruning behavior.
      rm.admitAndAddPeer("room1", peer("u2", OUTSIDE_B, "s-u2"), 100);
      rm.admitAndAddPeer("room1", peer("u1", INSIDE_MEETING_A, "s1"), 100);
      rm.runTickForTest("room1"); // zoneOf["u1"] = meet-a-zone

      await rm.removePeer("room1", "u1");
      rm.admitAndAddPeer("room1", peer("u1", INSIDE_MEETING_A, "s1-new"), 100); // same userId, same zone

      emitted.length = 0;
      rm.runTickForTest("room1");

      // Without pruning, zoneOf would still say "meet-a-zone" from before
      // the peer left, see no change on rejoin, and never notify the new
      // socket — exactly the rejoin bug proximityStates' own pruning
      // (roomManager.ts:172-176) already guards against.
      const zoneChanged = emitted.find((e) => e.target === "s1-new" && e.event === "zone:changed");
      expect(zoneChanged?.payload).toMatchObject({ zone: { label: "Meeting Room A" } });
    });

    it("lastEmittedAudio is pruned on removePeer — a rejoining user's new socket still receives the current state", async () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("u1", INSIDE_MEETING_A, "s1"), 100);
      rm.admitAndAddPeer("room1", peer("u2", INSIDE_MEETING_B, "s-u2"), 100);
      rm.runTickForTest("room1"); // caches full-gain lastEmittedAudio for both directions

      await rm.removePeer("room1", "u1");
      rm.admitAndAddPeer("room1", peer("u1", INSIDE_MEETING_A, "s1-new"), 100); // rejoins, same zone/state

      emitted.length = 0;
      rm.runTickForTest("room1");

      // Without pruning, lastEmittedAudio would still hold the identical
      // full-gain value from before u1 left, the dedupe check would see
      // "no change", and u1's brand-new socket would never receive
      // anything at all.
      const audioToNewSocket = emitted.find((e) => e.target === "s1-new" && e.event === "proximity:update");
      expect(audioToNewSocket?.payload).toMatchObject({ peerId: "u2", audioSubscribed: true, audioGain: 1 });
    });

    // All Hands: stage rect col4,row0,cols3,rows1 -> world x:[640,1120) y:[0,160).
    // Audience rect col4,row1,cols3,rows2 -> world x:[640,1120) y:[160,480).
    const ON_STAGE = { x: 641, y: 1 };
    const FAR_AUDIENCE_CORNER = { x: 1119, y: 479 }; // ~676px from ON_STAGE — NOT a grid candidate (cell 525px)
    const NEUTRAL_1 = { x: 50, y: 700 };
    const NEUTRAL_2 = { x: 50, y: 1300 };

    it("an audience member hears a stage speaker at full gain even though they are physically far apart (not a grid neighbour)", () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("speaker", NEUTRAL_1, "s-speaker"), 100);
      rm.admitAndAddPeer("room1", peer("listener", NEUTRAL_2, "s-listener"), 100);
      rm.runTickForTest("room1");

      // Confirm they are genuinely not grid neighbours before the zone move.
      expect(Math.hypot(ON_STAGE.x - FAR_AUDIENCE_CORNER.x, ON_STAGE.y - FAR_AUDIENCE_CORNER.y)).toBeGreaterThan(525);

      emitted.length = 0;
      rm.admitAndAddPeer("room1", peer("speaker", ON_STAGE, "s-speaker"), 100);
      rm.admitAndAddPeer("room1", peer("listener", FAR_AUDIENCE_CORNER, "s-listener"), 100);
      rm.runTickForTest("room1");

      const audioToListener = emitted.find((e) => e.target === "s-listener" && e.event === "proximity:update");
      expect(audioToListener?.payload).toMatchObject({ peerId: "speaker", audioSubscribed: true, audioGain: 1 });

      // The reverse direction is deliberately NOT full-gain (the table's
      // "stage S <- audience of S: raw") — since they're genuinely far
      // apart, the speaker should never be told they're subscribed. (A
      // candidate pair examined for the first time in either direction
      // always reports its true state once, even NOT_NEARBY — the same
      // "first sight" behavior Phase 8 always had — so an explicit
      // unsubscribed message here is fine; a subscribed one would not be.)
      const audioToSpeaker = emitted.find((e) => e.target === "s-speaker" && e.event === "proximity:update");
      if (audioToSpeaker) {
        expect(audioToSpeaker.payload).toMatchObject({ peerId: "listener", audioSubscribed: false });
      }
    });

    it("leaving the audience zone (while still far from the stage) correctly reverts to muted, not stuck at full gain", () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("speaker", ON_STAGE, "s-speaker"), 100);
      rm.admitAndAddPeer("room1", peer("listener", FAR_AUDIENCE_CORNER, "s-listener"), 100);
      rm.runTickForTest("room1"); // listener now hears speaker at full gain

      emitted.length = 0;
      // Listener leaves the audience zone but stays just as far away.
      rm.admitAndAddPeer("room1", peer("listener", NEUTRAL_2, "s-listener"), 100);
      rm.runTickForTest("room1");

      const audioToListener = emitted.find((e) => e.target === "s-listener" && e.event === "proximity:update");
      expect(audioToListener?.payload).toMatchObject({ peerId: "speaker", audioSubscribed: false });
    });
  });

  describe("disconnect cleanup (Phase 9 sparse structures)", () => {
    function peer(userId: string, position: { x: number; y: number }, socketId = `s-${userId}`) {
      return { userId, name: userId, avatarUrl: null, socketId, position };
    }

    it("removePeer drops the departing user from the spatial index, the proximity tracker, zone membership, and directed audio maps — without touching unrelated peers", async () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      const A = { x: 0, y: 700 };
      const B = { x: 50, y: 700 }; // near A
      const C = { x: 60, y: 700 }; // near A and B
      rm.admitAndAddPeer("room1", peer("a", A), 100);
      rm.admitAndAddPeer("room1", peer("b", B), 100);
      rm.admitAndAddPeer("room1", peer("c", C), 100);
      rm.runTickForTest("room1");

      expect(rm.proximityStateForTest("room1", "a", "b")?.audioSubscribed).toBe(true);
      expect(rm.proximityStateForTest("room1", "a", "c")?.audioSubscribed).toBe(true);
      expect(rm.proximityStateForTest("room1", "b", "c")?.audioSubscribed).toBe(true);

      await rm.removePeer("room1", "a");

      // a's pairs are gone...
      expect(rm.proximityStateForTest("room1", "a", "b")).toBeUndefined();
      expect(rm.proximityStateForTest("room1", "a", "c")).toBeUndefined();
      // ...but b/c, who never left, are untouched.
      expect(rm.proximityStateForTest("room1", "b", "c")?.audioSubscribed).toBe(true);
      expect(rm.snapshot("room1").map((p) => p.userId).sort()).toEqual(["b", "c"]);
    });

    it("a reconnecting user (same userId) re-triggers proximity:update against a peer who never left", async () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      const A = { x: 0, y: 700 };
      const B = { x: 50, y: 700 };
      rm.admitAndAddPeer("room1", peer("a", A, "s-a-old"), 100);
      rm.admitAndAddPeer("room1", peer("b", B, "s-b"), 100);
      rm.runTickForTest("room1");

      await rm.removePeer("room1", "a");
      rm.admitAndAddPeer("room1", peer("a", A, "s-a-new"), 100); // identical position, new socket

      emitted.length = 0;
      rm.runTickForTest("room1");

      const audioToNewSocket = emitted.find((e) => e.target === "s-a-new" && e.event === "proximity:update");
      expect(audioToNewSocket?.payload).toMatchObject({ peerId: "b", audioSubscribed: true });
    });
  });

  describe("zone-transition oracle (grid + sparse tracker vs the zoneAudio table, ground truth)", () => {
    // Verifies, via a SCRIPTED sequence, that RoomManager's emitted directed
    // audio exactly matches what the pure `effectiveAudio` function (already
    // exhaustively unit-tested in zoneAudio.test.ts) says it should be, for
    // every transition the plan called out: raw-nearby <-> raw-far, both in
    // the same meeting room, stage <-> its FAR audience, different private
    // zones, open zone <-> no zone, and focus. This is the guard against a
    // regression where the grid/tracker correctly find nearby pairs but the
    // zone candidate-generation misses a pair the audio table says should
    // still update.
    function peer(userId: string, position: { x: number; y: number }, socketId = `s-${userId}`) {
      return { userId, name: userId, avatarUrl: null, socketId, position };
    }

    // Meeting Room A: world x:[0,640) y:[0,480). Meeting Room B is a
    // separate private zone elsewhere on the floor — use the "no zone" desk
    // grid area (col0-2,row3-8) as a stand-in "different private zone" via
    // Meeting Room A vs Cabin 1 (a real second private zone in openOffice1).
    const RAW_NEARBY = { a: { x: 0, y: 700 }, b: { x: 50, y: 700 } }; // 50px apart, no zone
    const RAW_FAR = { a: { x: 0, y: 700 }, b: { x: 4000, y: 4000 } };
    const MEETING_A_1 = { x: 10, y: 100 };
    const MEETING_A_2 = { x: 600, y: 100 }; // same zone, ~590px apart (not a grid neighbour)
    const STAGE = { x: 641, y: 1 };
    const AUDIENCE_FAR = { x: 1119, y: 479 };

    it("matches effectiveAudio's ground truth at every scripted transition", () => {
      const { broadcaster, emitted } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("a", RAW_NEARBY.a), 100);
      rm.admitAndAddPeer("room1", peer("b", RAW_NEARBY.b), 100);
      rm.runTickForTest("room1");

      function assertListenerHears(listenerSocket: string, speakerId: string, subscribed: boolean, gain?: number) {
        const update = emitted.find((e) => e.target === listenerSocket && e.event === "proximity:update");
        if (!subscribed) {
          // Either no update at all (never was subscribed) or an explicit
          // unsubscribe transition — both are valid "not hearing them".
          if (update) expect(update.payload).toMatchObject({ peerId: speakerId, audioSubscribed: false });
          return;
        }
        expect(update?.payload).toMatchObject({
          peerId: speakerId,
          audioSubscribed: true,
          ...(gain !== undefined ? { audioGain: gain } : {}),
        });
      }

      // Step 1: raw-nearby, no zone -> both hear each other (raw proximity).
      assertListenerHears("s-a", "b", true, 1);
      assertListenerHears("s-b", "a", true, 1);

      // Step 2: move far apart, no zone -> both revert to not hearing.
      emitted.length = 0;
      rm.admitAndAddPeer("room1", peer("a", RAW_FAR.a), 100);
      rm.admitAndAddPeer("room1", peer("b", RAW_FAR.b), 100);
      rm.runTickForTest("room1");
      assertListenerHears("s-a", "b", false);
      assertListenerHears("s-b", "a", false);

      // Step 3: both into Meeting Room A, far apart WITHIN the zone (not a
      // grid neighbour) -> zone override grants full gain both ways.
      emitted.length = 0;
      rm.admitAndAddPeer("room1", peer("a", MEETING_A_1), 100);
      rm.admitAndAddPeer("room1", peer("b", MEETING_A_2), 100);
      rm.runTickForTest("room1");
      assertListenerHears("s-a", "b", true, 1);
      assertListenerHears("s-b", "a", true, 1);

      // Step 4: b moves to the All Hands stage, a stays in Meeting Room A —
      // different private/stage zones -> a is muted toward b (a is in a
      // private zone, only shares audio with someone in the SAME private
      // zone), and b (stage, not private) hears raw proximity from a, which
      // is far -> not subscribed either.
      emitted.length = 0;
      rm.admitAndAddPeer("room1", peer("b", STAGE), 100);
      rm.runTickForTest("room1");
      assertListenerHears("s-a", "b", false);
      assertListenerHears("s-b", "a", false);

      // Step 5: a moves to the All Hands audience, far from the stage where
      // b now is -> a (audience) hears b (stage) at full gain; b does NOT
      // get a spurious full-gain update back (stage<-audience is raw).
      emitted.length = 0;
      rm.admitAndAddPeer("room1", peer("a", AUDIENCE_FAR), 100);
      rm.runTickForTest("room1");
      assertListenerHears("s-a", "b", true, 1);
      assertListenerHears("s-b", "a", false);

      // Step 6: a leaves the audience zone (back to no zone), still far from
      // b -> reverts to not hearing at all.
      emitted.length = 0;
      rm.admitAndAddPeer("room1", peer("a", RAW_FAR.a), 100);
      rm.runTickForTest("room1");
      assertListenerHears("s-a", "b", false);
    });
  });

  describe("getTickStats — Phase 10 per-phase breakdown", () => {
    function peer(userId: string, position: { x: number; y: number }, socketId = `s-${userId}`) {
      return { userId, name: userId, avatarUrl: null, socketId, position };
    }

    it("reports all-zero phase stats before any tick has run", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      const stats = rm.getTickStats();
      expect(stats.sampleCount).toBe(0);
      expect(stats.phases.positions).toEqual({ avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 });
      expect(stats.phases.proximity).toEqual({ avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 });
      expect(stats.phases.zone).toEqual({ avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 });
      expect(stats.phases.audioEmit).toEqual({ avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 });
    });

    it("records non-negative phase timings that sum to roughly the overall tick duration, after a real tick", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.admitAndAddPeer("room1", peer("a", { x: 0, y: 0 }), 100);
      rm.admitAndAddPeer("room1", peer("b", { x: 50, y: 0 }), 100);
      rm.runTickForTest("room1");

      const stats = rm.getTickStats();
      expect(stats.sampleCount).toBe(1);
      expect(stats.phases.positions.avgMs).toBeGreaterThanOrEqual(0);
      expect(stats.phases.proximity.avgMs).toBeGreaterThanOrEqual(0);
      expect(stats.phases.zone.avgMs).toBeGreaterThanOrEqual(0);
      expect(stats.phases.audioEmit.avgMs).toBeGreaterThanOrEqual(0);

      const phaseSum =
        stats.phases.positions.avgMs + stats.phases.proximity.avgMs + stats.phases.zone.avgMs + stats.phases.audioEmit.avgMs;
      // The four phases are sequential marks within the same tick, so their
      // sum should be very close to (never meaningfully larger than) the
      // overall recorded tick duration — a small epsilon covers timer
      // granularity, not a real gap.
      expect(phaseSum).toBeLessThanOrEqual(stats.avgMs + 1);
    });

    it("does not record a phase sample for a tick on an empty/nonexistent room", () => {
      const { broadcaster } = fakeBroadcaster();
      const rm = createManager(broadcaster, fakeLease(), "instance-a");
      rm.ensureRoom("room1", "ws1");
      rm.runTickForTest("room1"); // no peers — tickBody returns undefined

      const stats = rm.getTickStats();
      // The overall duration IS still sampled (tick() always records it),
      // but the phase buffers must not have grown from a tick that never
      // reached the phase-marking code.
      expect(stats.sampleCount).toBe(1);
      expect(stats.phases.positions).toEqual({ avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 });
    });
  });
});
