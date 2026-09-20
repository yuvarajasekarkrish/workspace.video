import { describe, it, expect } from "vitest";
import { SparseProximityTracker, tickProximity, pairKey, NOT_NEARBY, type ProximityState } from "../proximity";
import { UniformGridIndex } from "../spatial-index";
import { DEFAULT_PROXIMITY_CONFIG } from "@workspace-video/shared";
import type { Point } from "@workspace-video/shared";

const cfg = DEFAULT_PROXIMITY_CONFIG;
const CELL = cfg.audioRadiusPx + cfg.hysteresisPx;

function makeIndex(width = 5000, height = 5000): UniformGridIndex {
  return new UniformGridIndex(width, height, CELL);
}

describe("SparseProximityTracker — basic detection", () => {
  it("detects two nearby users and stores the state", () => {
    const index = makeIndex();
    index.insert("a", { x: 0, y: 0 });
    index.insert("b", { x: 50, y: 0 });

    const tracker = new SparseProximityTracker();
    const changes: [string, string, ProximityState][] = [];
    tracker.tick(index, cfg, (a, b, s) => changes.push([a, b, s]));

    expect(changes).toHaveLength(1);
    expect(changes[0]![2].audioSubscribed).toBe(true);
    expect(tracker.stateFor("a", "b")?.audioSubscribed).toBe(true);
  });

  it("never stores or emits for users far outside the audio radius", () => {
    const index = makeIndex();
    index.insert("a", { x: 0, y: 0 });
    index.insert("b", { x: 4000, y: 4000 });

    const tracker = new SparseProximityTracker();
    const changes: unknown[] = [];
    tracker.tick(index, cfg, (...args) => changes.push(args));

    expect(changes).toHaveLength(0);
    expect(tracker.stateFor("a", "b")).toBeUndefined();
  });
});

describe("SparseProximityTracker — entering/leaving AOI", () => {
  it("emits exactly one NOT_NEARBY change and clears storage when a pair moves apart", () => {
    const index = makeIndex();
    index.insert("a", { x: 0, y: 0 });
    index.insert("b", { x: 50, y: 0 });
    const tracker = new SparseProximityTracker();
    tracker.tick(index, cfg, () => {});
    expect(tracker.stateFor("a", "b")).toBeDefined();

    index.move("b", { x: 4000, y: 4000 });
    const changes: [string, string, ProximityState][] = [];
    tracker.tick(index, cfg, (a, b, s) => changes.push([a, b, s]));

    expect(changes).toHaveLength(1);
    expect(changes[0]![2]).toEqual(NOT_NEARBY);
    expect(tracker.stateFor("a", "b")).toBeUndefined();
  });

  it("re-entering AOI after leaving re-emits a nearby state", () => {
    const index = makeIndex();
    index.insert("a", { x: 0, y: 0 });
    index.insert("b", { x: 50, y: 0 });
    const tracker = new SparseProximityTracker();
    tracker.tick(index, cfg, () => {});

    index.move("b", { x: 4000, y: 4000 });
    tracker.tick(index, cfg, () => {});
    expect(tracker.stateFor("a", "b")).toBeUndefined();

    index.move("b", { x: 60, y: 0 });
    const changes: [string, string, ProximityState][] = [];
    tracker.tick(index, cfg, (a, b, s) => changes.push([a, b, s]));
    expect(changes).toHaveLength(1);
    expect(changes[0]![2].audioSubscribed).toBe(true);
  });
});

describe("SparseProximityTracker — hysteresis across a cell boundary", () => {
  it("keeps an already-subscribed pair audio-subscribed within the hysteresis band even after crossing radius", () => {
    const index = makeIndex();
    index.insert("a", { x: 0, y: 0 });
    index.insert("b", { x: 400, y: 0 }); // within audioRadiusPx (500)
    const tracker = new SparseProximityTracker();
    tracker.tick(index, cfg, () => {});
    expect(tracker.stateFor("a", "b")?.audioSubscribed).toBe(true);

    // Move just past the radius but within radius + hysteresis (500-525).
    // Gain is a continuous function of distance, so a change IS expected
    // here (gain ramps down) — what hysteresis guarantees is that
    // audioSubscribed itself does not flip to false, unlike a fresh pair
    // first crossing the plain 500px radius would.
    index.move("b", { x: 510, y: 0 });
    const changes: [string, string, ProximityState][] = [];
    tracker.tick(index, cfg, (a, b, s) => changes.push([a, b, s]));
    expect(changes).toHaveLength(1);
    expect(changes[0]![2].audioSubscribed).toBe(true);
    expect(tracker.stateFor("a", "b")?.audioSubscribed).toBe(true);
  });
});

describe("SparseProximityTracker — removeUser cleanup", () => {
  it("drops all of a user's stored pairs in O(degree), not leaving stale entries", () => {
    const index = makeIndex();
    index.insert("a", { x: 0, y: 0 });
    index.insert("b", { x: 50, y: 0 });
    index.insert("c", { x: 60, y: 0 });
    const tracker = new SparseProximityTracker();
    tracker.tick(index, cfg, () => {});
    expect(tracker.stateFor("a", "b")).toBeDefined();
    expect(tracker.stateFor("a", "c")).toBeDefined();

    tracker.removeUser("a");
    expect(tracker.stateFor("a", "b")).toBeUndefined();
    expect(tracker.stateFor("a", "c")).toBeUndefined();
    // b/c pair is untouched.
    expect(tracker.stateFor("b", "c")).toBeDefined();
  });

  it("a rejoining user with the same id re-emits proximity even against a peer who never left (no stale suppress)", () => {
    const index = makeIndex();
    index.insert("a", { x: 0, y: 0 });
    index.insert("b", { x: 50, y: 0 });
    const tracker = new SparseProximityTracker();
    tracker.tick(index, cfg, () => {});

    tracker.removeUser("a");
    index.remove("a");
    index.insert("a", { x: 0, y: 0 }); // "rejoin" at an identical position

    const changes: [string, string, ProximityState][] = [];
    tracker.tick(index, cfg, (a, b, s) => changes.push([a, b, s]));
    expect(changes).toHaveLength(1);
    expect(changes[0]![2].audioSubscribed).toBe(true);
  });
});

describe("SparseProximityTracker vs tickProximity — equivalence (random walk)", () => {
  it("emits the same changes as the naive full-pair scan, ignoring first-sight NOT_NEARBY reports", () => {
    const width = 3000;
    const height = 3000;
    const rng = mulberry32(7);
    const n = 40;

    const index = makeIndex(width, height);
    const tracker = new SparseProximityTracker();
    const naivePositions = new Map<string, Point>();
    const naivePrevStates = new Map<string, ProximityState>();
    const firstSeenAtTick = new Map<string, number>();
    function hadPriorState(key: string, tick: number): boolean {
      const firstSeen = firstSeenAtTick.get(key);
      if (firstSeen === undefined) {
        firstSeenAtTick.set(key, tick);
        return false;
      }
      return true;
    }

    const points: { id: string; x: number; y: number; vx: number; vy: number }[] = [];
    for (let i = 0; i < n; i++) {
      const id = `u${i}`;
      const x = rng() * width;
      const y = rng() * height;
      points.push({ id, x, y, vx: (rng() - 0.5) * 40, vy: (rng() - 0.5) * 40 });
      index.insert(id, { x, y });
      naivePositions.set(id, { x, y });
    }

    for (let tick = 0; tick < 30; tick++) {
      for (const p of points) {
        p.x = Math.min(Math.max(p.x + p.vx, 0), width);
        p.y = Math.min(Math.max(p.y + p.vy, 0), height);
        index.move(p.id, { x: p.x, y: p.y });
        naivePositions.set(p.id, { x: p.x, y: p.y });
      }

      const sparseChanges = new Map<string, ProximityState>();
      tracker.tick(index, cfg, (a, b, s) => sparseChanges.set(pairKey(a, b), s));

      const naiveChangesRaw = tickProximity(naivePositions, naivePrevStates, cfg);
      const naiveChanges = new Map<string, ProximityState>();
      for (const c of naiveChangesRaw) {
        naivePrevStates.set(pairKey(c.a, c.b), c.state);
        // Ignore first-sight NOT_NEARBY reports — the sparse tracker never
        // stored/emitted those pairs in the first place (documented
        // divergence; both are equivalent for every actual audio consumer).
        if (c.state.audioSubscribed || hadPriorState(pairKey(c.a, c.b), tick)) {
          naiveChanges.set(pairKey(c.a, c.b), c.state);
        }
      }

      // Every change the naive scan reports for a pair the sparse tracker
      // could also know about (i.e. not a "first sight of a far pair") must
      // have been emitted by the tracker THIS SAME TICK, with the same state.
      for (const [key, state] of naiveChanges) {
        expect(sparseChanges.get(key)).toEqual(state);
      }
    }
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
