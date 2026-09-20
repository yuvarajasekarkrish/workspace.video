import { describe, it, expect, vi, afterEach } from "vitest";
import type { RoomLease } from "@cosmos/realtime-core";
import { RoomManager, type RoomBroadcaster } from "../roomManager.js";

type Emitted = { target: string; event: string; payload: unknown };

function fakeBroadcaster() {
  const emitted: Emitted[] = [];
  const broadcaster: RoomBroadcaster = {
    to: (target) => ({ emit: (event, payload) => void emitted.push({ target, event, payload }) }),
    disconnectSocketsInRoom: vi.fn(),
  };
  return { broadcaster, emitted };
}

function fakeLease(): RoomLease {
  return {
    refresh: vi.fn().mockResolvedValue("renewed"),
    claimOrRead: vi.fn(),
    release: vi.fn(),
    currentOwner: vi.fn(),
  } as unknown as RoomLease;
}

type PeerSpec = { userId: string; socketId: string; x: number; proximityBatch?: boolean };

describe("proximity batching (opt-in)", () => {
  // Every manager a test creates is disposed (some tests build two to compare paths).
  const managers: RoomManager[] = [];
  afterEach(async () => {
    await Promise.all(managers.splice(0).map((m) => m.disposeAll()));
  });

  function setup(peers: PeerSpec[], options?: { proximityBatchEnabled?: boolean }) {
    const { broadcaster, emitted } = fakeBroadcaster();
    const rm = new RoomManager(broadcaster, fakeLease(), "instance-a", 10_000, undefined, undefined, options);
    managers.push(rm);
    rm.ensureRoom("room1", "ws1");
    for (const p of peers) admit(rm, p);
    return { rm, emitted };
  }

  function admit(rm: RoomManager, p: PeerSpec) {
    rm.admitAndAddPeer(
      "room1",
      {
        userId: p.userId,
        name: p.userId,
        avatarUrl: null,
        socketId: p.socketId,
        position: { x: p.x, y: 0 },
        ...(p.proximityBatch === undefined ? {} : { proximityBatch: p.proximityBatch }),
      },
      100,
    );
  }

  const three = (batchFor: Record<string, boolean | undefined> = {}): PeerSpec[] => [
    { userId: "u1", socketId: "s1", x: 0, proximityBatch: batchFor.u1 },
    { userId: "u2", socketId: "s2", x: 10, proximityBatch: batchFor.u2 },
    { userId: "u3", socketId: "s3", x: 20, proximityBatch: batchFor.u3 },
  ];

  const only = (emitted: Emitted[], target: string, event: string) =>
    emitted.filter((e) => e.target === target && e.event === event);

  /** Every proximity update a listener was told about in `emitted`, in either format, as a sorted multiset. */
  function updatesFor(emitted: Emitted[], target: string): string[] {
    const out: string[] = [];
    for (const e of emitted) {
      if (e.target !== target) continue;
      if (e.event === "proximity:update") out.push(JSON.stringify(e.payload));
      if (e.event === "proximity:batch") {
        for (const u of (e.payload as { updates: unknown[] }).updates) out.push(JSON.stringify(u));
      }
    }
    return out.sort();
  }

  it("sends an opted-in listener exactly one batch per tick and no per-peer updates", () => {
    const { rm, emitted } = setup(three({ u1: true }));
    rm.runTickForTest("room1");

    const batches = only(emitted, "s1", "proximity:batch");
    expect(batches).toHaveLength(1);
    const updates = (batches[0]!.payload as { updates: { peerId: string }[] }).updates;
    expect(updates.map((u) => u.peerId).sort()).toEqual(["u2", "u3"]);
    expect(only(emitted, "s1", "proximity:update")).toHaveLength(0);
  });

  it("mixed room: each side gets only its own format, with equivalent content to an all-legacy run", () => {
    const mixed = setup(three({ u1: true, u2: false })); // u3 absent = legacy
    mixed.rm.runTickForTest("room1");
    const reference = setup(three()); // everyone legacy, identical scenario
    reference.rm.runTickForTest("room1");

    // Batching listener: its batch only.
    expect(only(mixed.emitted, "s1", "proximity:batch")).toHaveLength(1);
    expect(only(mixed.emitted, "s1", "proximity:update")).toHaveLength(0);
    // Legacy listeners: individual updates only.
    for (const legacy of ["s2", "s3"]) {
      expect(only(mixed.emitted, legacy, "proximity:batch")).toHaveLength(0);
      expect(only(mixed.emitted, legacy, "proximity:update").length).toBeGreaterThan(0);
    }
    // Same information reaches every listener as in the all-legacy run.
    for (const socket of ["s1", "s2", "s3"]) {
      expect(updatesFor(mixed.emitted, socket)).toEqual(updatesFor(reference.emitted, socket));
    }
  });

  it("keeps the existing dedup authoritative: a quiet second tick sends nothing, in either format", () => {
    const { rm, emitted } = setup(three({ u1: true }));
    rm.runTickForTest("room1");
    emitted.length = 0;
    rm.runTickForTest("room1");
    expect(emitted.filter((e) => e.event === "proximity:batch" || e.event === "proximity:update")).toEqual([]);
  });

  it("delivers the same updates as the legacy path across ticks where distances change", async () => {
    // Leaving and rejoining at another distance is what makes the tracker see a change.
    const script = async (rm: RoomManager) => {
      rm.runTickForTest("room1");
      await rm.removePeer("room1", "u3");
      admit(rm, { userId: "u3", socketId: "s3", x: 400 }); // rejoins far away
      rm.runTickForTest("room1");
      await rm.removePeer("room1", "u3");
      admit(rm, { userId: "u3", socketId: "s3", x: 25 }); // and close again
      rm.runTickForTest("room1");
    };
    const batched = setup(three({ u1: true, u2: true }));
    await script(batched.rm);
    const legacy = setup(three());
    await script(legacy.rm);

    for (const socket of ["s1", "s2"]) {
      expect(updatesFor(batched.emitted, socket)).toEqual(updatesFor(legacy.emitted, socket));
    }
    // Some tick after the first must actually have carried changes, or this proves nothing.
    expect(only(batched.emitted, "s1", "proximity:batch").length).toBeGreaterThan(1);
  });

  it("flushes queued updates even when the tick throws mid-loop, and the throw is not swallowed", () => {
    // Throw on the 2nd pair. Whatever a legacy listener would already have been sent by then must
    // also reach a batching listener: nothing recorded as sent may be dropped by the deferral.
    const throwOnSecondPair = (rm: RoomManager) => {
      const room = (rm as unknown as { rooms: Map<string, { proximity: { stateFor: (a: string, b: string) => unknown } }> }).rooms.get("room1")!;
      const real = room.proximity.stateFor.bind(room.proximity);
      let calls = 0;
      vi.spyOn(room.proximity, "stateFor").mockImplementation((a: string, b: string) => {
        calls++;
        if (calls === 2) throw new Error("boom mid-loop");
        return real(a, b);
      });
    };

    const batched = setup(three({ u1: true, u2: true, u3: true }));
    throwOnSecondPair(batched.rm);
    expect(() => batched.rm.runTickForTest("room1")).toThrow("boom mid-loop");

    const legacy = setup(three());
    throwOnSecondPair(legacy.rm);
    expect(() => legacy.rm.runTickForTest("room1")).toThrow("boom mid-loop");

    const legacyDelivered = ["s1", "s2", "s3"].flatMap((s) => updatesFor(legacy.emitted, s));
    expect(legacyDelivered.length).toBeGreaterThan(0); // the throw really came after some updates
    for (const socket of ["s1", "s2", "s3"]) {
      expect(updatesFor(batched.emitted, socket)).toEqual(updatesFor(legacy.emitted, socket));
    }
  });

  it("the kill switch makes the server ignore an opt-in and use the legacy path", () => {
    const { rm, emitted } = setup(three({ u1: true }), { proximityBatchEnabled: false });
    rm.runTickForTest("room1");
    expect(only(emitted, "s1", "proximity:batch")).toHaveLength(0);
    expect(only(emitted, "s1", "proximity:update").length).toBeGreaterThan(0);
  });

  describe("the capability belongs to the current connection, not the user", () => {
    it("a reconnect from a batching socket to a legacy one is legacy, and the old socket gets nothing", () => {
      const { rm, emitted } = setup(three({ u1: true }));
      admit(rm, { userId: "u1", socketId: "s1-new", x: 0, proximityBatch: false });
      emitted.length = 0;
      // A fresh room state so every pair re-emits: bounce another peer.
      admit(rm, { userId: "u2", socketId: "s2", x: 60 });
      rm.runTickForTest("room1");

      expect(emitted.filter((e) => e.target === "s1")).toEqual([]);
      expect(only(emitted, "s1-new", "proximity:batch")).toHaveLength(0);
      expect(only(emitted, "s1-new", "proximity:update").length).toBeGreaterThan(0);
    });

    it("a reconnect from a legacy socket to a batching one is batching", () => {
      const { rm, emitted } = setup(three());
      admit(rm, { userId: "u1", socketId: "s1-new", x: 0, proximityBatch: true });
      admit(rm, { userId: "u2", socketId: "s2", x: 60 });
      emitted.length = 0;
      rm.runTickForTest("room1");

      expect(only(emitted, "s1-new", "proximity:batch")).toHaveLength(1);
      expect(only(emitted, "s1-new", "proximity:update")).toHaveLength(0);
    });

    it("a re-sent join on the same socket takes the latest value", () => {
      const { rm, emitted } = setup(three({ u1: false }));
      admit(rm, { userId: "u1", socketId: "s1", x: 0, proximityBatch: true });
      admit(rm, { userId: "u2", socketId: "s2", x: 60 });
      emitted.length = 0;
      rm.runTickForTest("room1");
      expect(only(emitted, "s1", "proximity:batch")).toHaveLength(1);
    });

    it("a stale socket's disconnect does not disturb the live connection's capability", async () => {
      const { rm, emitted } = setup(three({ u1: true }));
      admit(rm, { userId: "u1", socketId: "s1-new", x: 0, proximityBatch: false });
      await rm.removePeer("room1", "u1", "s1"); // old socket's late disconnect: ignored
      admit(rm, { userId: "u2", socketId: "s2", x: 60 });
      emitted.length = 0;
      rm.runTickForTest("room1");

      expect(only(emitted, "s1-new", "proximity:batch")).toHaveLength(0);
      expect(only(emitted, "s1-new", "proximity:update").length).toBeGreaterThan(0);
    });
  });

  it("counts logical updates separately from frames so a framing change is not read as lost updates", () => {
    const { rm } = setup(three({ u1: true })); // u1 batches, u2 and u3 do not
    rm.runTickForTest("room1");
    const stats = rm.getProximityBatchStats();
    // 3 pairs x 2 directions = 6 updates: u1 gets 2 (one batch frame), u2 and u3 get 2 each (4 frames).
    expect(stats.updatesTotal).toBe(6);
    expect(stats.batchedUpdatesTotal).toBe(2);
    expect(stats.batchFramesTotal).toBe(1);
    expect(stats.legacyFramesTotal).toBe(4);
    expect(stats.batchedUpdatesTotal + stats.legacyFramesTotal).toBe(stats.updatesTotal);
  });
});
