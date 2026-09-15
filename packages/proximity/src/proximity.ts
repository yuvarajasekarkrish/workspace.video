import type { Point } from "@cosmos/shared";
import { DEFAULT_PROXIMITY_CONFIG, type ProximityConfig } from "@cosmos/shared";
import type { SpatialIndex } from "./spatial-index";

export interface ProximityState {
  audioSubscribed: boolean;
  audioGain: number;
  videoSubscribed: boolean;
}

const NOT_NEARBY: ProximityState = {
  audioSubscribed: false,
  audioGain: 0,
  videoSubscribed: false,
};

function distance(a: Point, b: Point): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Pure distance -> proximity state, with hysteresis applied via the previous
 * state so a pair loitering exactly on a boundary doesn't flap subscriptions.
 * No I/O, no randomness — safe to call every tick for every pair.
 */
export function computeProximityState(
  d: number,
  previous: ProximityState | undefined,
  config: ProximityConfig = DEFAULT_PROXIMITY_CONFIG,
): ProximityState {
  const { videoRadiusPx, audioRadiusPx, hysteresisPx } = config;
  const wasVideo = previous?.videoSubscribed ?? false;
  const wasAudio = previous?.audioSubscribed ?? false;

  // Hysteresis: once subscribed, only unsubscribe after crossing radius + hysteresis.
  // Once unsubscribed, only (re-)subscribe after crossing back within radius (no
  // outward slack on the "join" edge — that would let people hear through walls).
  const videoSubscribed = wasVideo ? d <= videoRadiusPx + hysteresisPx : d <= videoRadiusPx;
  const audioSubscribed = wasAudio ? d <= audioRadiusPx + hysteresisPx : d <= audioRadiusPx;

  if (!audioSubscribed) {
    return { audioSubscribed: false, audioGain: 0, videoSubscribed: false };
  }

  const gain =
    d <= videoRadiusPx
      ? 1
      : Math.max(0, 1 - (d - videoRadiusPx) / (audioRadiusPx - videoRadiusPx));

  return {
    audioSubscribed: true,
    audioGain: gain,
    videoSubscribed,
  };
}

/** Exported so callers outside this module (RoomManager's zone-audio dedupe)
 *  can compare two ProximityState values the same way tickProximity does
 *  internally, rather than re-rolling the epsilon comparison. */
export function statesEqual(a: ProximityState, b: ProximityState): boolean {
  return (
    a.audioSubscribed === b.audioSubscribed &&
    a.videoSubscribed === b.videoSubscribed &&
    Math.abs(a.audioGain - b.audioGain) < 1e-6
  );
}

export type PairKey = string;

export function pairKey(a: string, b: string): PairKey {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export interface ProximityChange {
  a: string;
  b: string;
  state: ProximityState;
}

/**
 * Recomputes proximity for every pair of ids present in `positions`, diffs
 * against `previousStates`, and returns only the pairs whose state changed
 * (per the module contract: proximity:update fires on change, not every tick).
 * Mutates nothing; caller decides how to persist `previousStates` for the next tick.
 */
export function tickProximity(
  positions: Map<string, Point>,
  previousStates: Map<PairKey, ProximityState>,
  config: ProximityConfig = DEFAULT_PROXIMITY_CONFIG,
): ProximityChange[] {
  const ids = Array.from(positions.keys());
  const changes: ProximityChange[] = [];

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      const key = pairKey(a, b);
      const d = distance(positions.get(a)!, positions.get(b)!);
      const prev = previousStates.get(key);
      const next = computeProximityState(d, prev, config);

      if (!prev || !statesEqual(prev, next)) {
        changes.push({ a, b, state: next });
      }
    }
  }

  return changes;
}

/**
 * O(candidate-pairs) replacement for `tickProximity` + a full-pair
 * `previousStates` Map, used by RoomManager from Phase 9 on. `tickProximity`
 * above is left exactly as-is (still used as the correctness oracle in
 * tests) — this class only changes HOW candidate pairs and storage are
 * found, never the distance -> state math (`computeProximityState`, reused
 * unchanged) or the change-only-on-diff contract.
 *
 * Storage holds ONLY pairs currently in a non-NOT_NEARBY state, indexed both
 * ways (`Map<userId, Map<userId, ProximityState>>`), so a user's removal or
 * a pair's return to NOT_NEARBY are both O(degree) instead of O(n) or O(all
 * pairs ever seen). A pair that was never nearby is never stored and never
 * emitted — this is intentionally a divergence from `tickProximity`, which
 * always reports a change the very first time it sees ANY pair (including a
 * NOT_NEARBY one); every consumer of proximity:update already treats "never
 * received an update for this peer" as NOT_NEARBY (see
 * apps/web/src/store/proximityStore.ts), so this is invisible to clients.
 */
export class SparseProximityTracker {
  private states = new Map<string, Map<string, ProximityState>>();
  /** Per-pair "last tick visited" stamp, keyed the same as `states`'s inner
   *  maps, reusing the current tick's monotonic counter — lets tick() detect
   *  "was nearby last tick, wasn't a grid candidate this tick" (i.e. moved
   *  further than cellSize apart) without allocating a Set every tick. */
  private lastSeenTick = new Map<string, Map<string, number>>();
  private tickCounter = 0;

  private innerGet(map: Map<string, Map<string, ProximityState>>, a: string, b: string): ProximityState | undefined {
    return map.get(a)?.get(b);
  }

  private innerSet(a: string, b: string, value: ProximityState): void {
    let fromA = this.states.get(a);
    if (!fromA) {
      fromA = new Map();
      this.states.set(a, fromA);
    }
    fromA.set(b, value);

    let fromB = this.states.get(b);
    if (!fromB) {
      fromB = new Map();
      this.states.set(b, fromB);
    }
    fromB.set(a, value);
  }

  private innerDelete(a: string, b: string): void {
    this.states.get(a)?.delete(b);
    this.states.get(b)?.delete(a);
  }

  private stampSeen(a: string, b: string, tick: number): void {
    let fromA = this.lastSeenTick.get(a);
    if (!fromA) {
      fromA = new Map();
      this.lastSeenTick.set(a, fromA);
    }
    fromA.set(b, tick);

    let fromB = this.lastSeenTick.get(b);
    if (!fromB) {
      fromB = new Map();
      this.lastSeenTick.set(b, fromB);
    }
    fromB.set(a, tick);
  }

  /** The currently-stored (non-NOT_NEARBY) state for a pair, or undefined if
   *  neither direction has one — powers RoomManager's `proximityStateForTest`
   *  and the zone-audio candidate lookup. */
  stateFor(a: string, b: string): ProximityState | undefined {
    return this.innerGet(this.states, a, b);
  }

  /** Every id currently in a stored (non-NOT_NEARBY) pair with `id` — used
   *  by RoomManager to build the zone-change candidate set in O(degree)
   *  instead of scanning every peer in the room. Returns an empty iterable
   *  for a user with no stored pairs. */
  neighborsOf(id: string): IterableIterator<string> {
    return (this.states.get(id)?.keys() ?? new Map<string, ProximityState>().keys());
  }

  /** Drops every stored entry (both state and last-seen stamps) touching
   *  `id` — called on disconnect. O(degree), never O(n) or O(all pairs). */
  removeUser(id: string): void {
    const neighbors = this.states.get(id);
    if (neighbors) {
      for (const otherId of neighbors.keys()) {
        this.states.get(otherId)?.delete(id);
      }
      this.states.delete(id);
    }
    const seenNeighbors = this.lastSeenTick.get(id);
    if (seenNeighbors) {
      for (const otherId of seenNeighbors.keys()) {
        this.lastSeenTick.get(otherId)?.delete(id);
      }
      this.lastSeenTick.delete(id);
    }
  }

  /**
   * Runs one proximity tick: visits every candidate pair the spatial index
   * produces (guaranteed to include every pair within `radius + hysteresis`
   * of each other — see UniformGridIndex's doc comment), computes state only
   * for those, and separately detects pairs that WERE nearby last tick but
   * are no longer even grid-candidates (moved beyond the cell radius) to
   * emit their NOT_NEARBY transition. `onChange` is called for every pair
   * whose state actually changed, matching `tickProximity`'s contract.
   */
  tick(
    index: SpatialIndex,
    config: ProximityConfig = DEFAULT_PROXIMITY_CONFIG,
    onChange: (a: string, b: string, state: ProximityState) => void,
  ): void {
    const tick = ++this.tickCounter;
    const maxCandidateDistPx = config.audioRadiusPx + config.hysteresisPx;
    const maxCandidateDist2 = maxCandidateDistPx * maxCandidateDistPx;

    index.forEachCandidatePair((a, b) => {
      const pa = index.getPosition(a);
      const pb = index.getPosition(b);
      if (!pa || !pb) return;

      const dx = pa.x - pb.x;
      const dy = pa.y - pb.y;
      const d2 = dx * dx + dy * dy;
      // Cheap reject before the sqrt: definitely NOT_NEARBY and definitely
      // not already stored (the tracker never stores NOT_NEARBY), so
      // there's nothing to do or emit for this pair this tick.
      if (d2 > maxCandidateDist2) return;

      this.stampSeen(a, b, tick);

      const prev = this.innerGet(this.states, a, b);
      const d = Math.sqrt(d2);
      const next = computeProximityState(d, prev, config);

      if (!prev || !statesEqual(prev, next)) {
        if (next.audioSubscribed) {
          this.innerSet(a, b, next);
        } else {
          this.innerDelete(a, b);
        }
        onChange(a, b, next);
      }
    });

    // Any pair that was stored (non-NOT_NEARBY) before this tick but wasn't
    // stamped just now moved far enough apart that the grid no longer even
    // considers them candidates — which only happens once `d > cellSize`,
    // itself `>= audioRadiusPx + hysteresisPx`, so the true state is
    // unambiguously NOT_NEARBY. Emit that transition and drop the entry.
    const stale: [string, string][] = [];
    for (const [a, neighbors] of this.states) {
      for (const b of neighbors.keys()) {
        if (a >= b) continue; // visit each unordered pair once
        const seenA = this.lastSeenTick.get(a)?.get(b);
        if (seenA !== tick) stale.push([a, b]);
      }
    }
    for (const [a, b] of stale) {
      this.innerDelete(a, b);
      onChange(a, b, NOT_NEARBY);
    }
  }
}

export { NOT_NEARBY };
