import { describe, it, expect, vi, afterEach } from "vitest";
import type { RoomLease } from "@cosmos/realtime-core";
import { RoomManager, type RoomBroadcaster } from "../roomManager.js";

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

  afterEach(() => {
    activeManager?.disposeAll();
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

  it("removePeer emits a left-list delta and evicts the room once empty", () => {
    const { broadcaster, emitted } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.addPeer("room1", { userId: "u1", name: "Ann", avatarUrl: null, socketId: "s1", position: { x: 0, y: 0 } });

    rm.removePeer("room1", "u1");

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

  it("disposeAll clears every room's timers so no interval outlives the manager", () => {
    const { broadcaster } = fakeBroadcaster();
    const rm = createManager(broadcaster, fakeLease(), "instance-a");
    rm.ensureRoom("room1");
    rm.ensureRoom("room2");
    expect(rm.isOwnedLocally("room1")).toBe(true);
    expect(rm.isOwnedLocally("room2")).toBe(true);

    rm.disposeAll();

    expect(rm.isOwnedLocally("room1")).toBe(false);
    expect(rm.isOwnedLocally("room2")).toBe(false);
  });
});
