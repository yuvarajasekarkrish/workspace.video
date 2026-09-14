/**
 * Pure decision logic for turning server-authoritative proximity state into
 * LiveKit subscribe/unsubscribe actions and a smoothed volume. No LiveKit SDK
 * types appear here — everything is plain objects/strings so this is testable
 * without a Room, a Track, or any mock of them. See
 * apps/web/src/audio/SpatialAudioController.ts for the imperative shell that
 * drives an actual `Room` from these decisions.
 *
 * The distance -> gain curve itself is NOT reimplemented here — it already
 * lives, authoritatively, on the server (packages/proximity/src/proximity.ts)
 * and arrives over the wire as proximity:update. This module only decides
 * what to DO with that data on the client: whom to subscribe to, and how to
 * smooth the (already continuous) gain value into something that doesn't
 * step audibly at the 100ms server tick rate.
 */

import { stepScalarToward } from "@/canvas/interpolation";

/** One peer's desired audio state, as delivered by the most recent
 *  proximity:update for that peer. */
export interface DesiredPeerAudio {
  audioSubscribed: boolean;
  audioGain: number;
}

export type DesiredAudioState = ReadonlyMap<string, DesiredPeerAudio>;

/** Gain-ramp time constant. Fast enough to track someone walking at normal
 *  speed, slow enough to erase the 10Hz staircase produced by proximity:update
 *  firing on every tick while gain is continuously changing (see module docs
 *  in SpatialAudioController.ts for why that happens). */
export const AUDIO_GAIN_TAU_SECONDS = 0.15;

/** Below this, a gain is considered "arrived" — stops the self-stopping ramp
 *  loop rather than running it forever chasing a difference nobody can hear. */
export const GAIN_CONVERGED_EPSILON = 0.005;

/**
 * Looks up the *target* gain for a peer from desired state. Unknown or
 * currently-unsubscribed peers resolve to a flat 0 — this is the "safe
 * default is silence" rule that makes every ordering race harmless: whatever
 * order proximity data and LiveKit connection events arrive in, a peer with
 * no data yet is simply not heard, never accidentally heard at full volume.
 */
export function resolveTargetGain(desired: DesiredAudioState, peerId: string): number {
  const entry = desired.get(peerId);
  if (!entry || !entry.audioSubscribed) return 0;
  return entry.audioGain;
}

/**
 * One frame-rate-independent step of the gain ramp toward its target.
 * Thin named wrapper around the shared scalar-smoothing primitive so callers
 * read as "step gain", not "step some generic number".
 */
export function stepGainToward(
  current: number,
  target: number,
  dtSeconds: number,
  tauSeconds: number = AUDIO_GAIN_TAU_SECONDS,
): number {
  return stepScalarToward(current, target, dtSeconds, tauSeconds);
}

export function hasGainConverged(
  current: number,
  target: number,
  epsilon: number = GAIN_CONVERGED_EPSILON,
): boolean {
  return Math.abs(current - target) < epsilon;
}

/**
 * Given the set of peers we WANT to be subscribed to (per the latest
 * proximity data) and the set LiveKit currently reports as actually
 * subscribed, returns exactly what to change. Order-independent, and safe to
 * call redundantly — this is the "reconcile" half of the desired/actual split
 * described in SpatialAudioController.ts; nothing here mutates a Room.
 */
export function diffSubscriptions(
  desiredSubscribedPeerIds: ReadonlySet<string>,
  actualSubscribedPeerIds: ReadonlySet<string>,
): { toSubscribe: string[]; toUnsubscribe: string[] } {
  const toSubscribe: string[] = [];
  const toUnsubscribe: string[] = [];

  for (const peerId of desiredSubscribedPeerIds) {
    if (!actualSubscribedPeerIds.has(peerId)) toSubscribe.push(peerId);
  }
  for (const peerId of actualSubscribedPeerIds) {
    if (!desiredSubscribedPeerIds.has(peerId)) toUnsubscribe.push(peerId);
  }

  return { toSubscribe, toUnsubscribe };
}

/** Derives the desired-subscribed set directly from proximity state, for
 *  convenience at call sites that don't already have a Set built. */
export function desiredSubscribedPeerIds(desired: DesiredAudioState): Set<string> {
  const ids = new Set<string>();
  for (const [peerId, state] of desired) {
    if (state.audioSubscribed) ids.add(peerId);
  }
  return ids;
}
