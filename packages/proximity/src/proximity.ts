import type { Point } from "@cosmos/shared";
import { DEFAULT_PROXIMITY_CONFIG, type ProximityConfig } from "@cosmos/shared";

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

export { NOT_NEARBY };
