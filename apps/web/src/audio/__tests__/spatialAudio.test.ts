import { describe, it, expect } from "vitest";
import {
  resolveTargetGain,
  stepGainToward,
  hasGainConverged,
  diffSubscriptions,
  desiredSubscribedPeerIds,
  AUDIO_GAIN_TAU_SECONDS,
  type DesiredAudioState,
} from "../spatialAudio";

describe("resolveTargetGain", () => {
  it("returns 0 for a peer with no proximity data yet (safe default is silence)", () => {
    const desired: DesiredAudioState = new Map();
    expect(resolveTargetGain(desired, "u1")).toBe(0);
  });

  it("returns 0 for a peer explicitly marked unsubscribed even if a stale gain lingers", () => {
    const desired: DesiredAudioState = new Map([["u1", { audioSubscribed: false, audioGain: 0.8 }]]);
    expect(resolveTargetGain(desired, "u1")).toBe(0);
  });

  it("returns the peer's gain when subscribed", () => {
    const desired: DesiredAudioState = new Map([["u1", { audioSubscribed: true, audioGain: 0.42 }]]);
    expect(resolveTargetGain(desired, "u1")).toBe(0.42);
  });
});

describe("stepGainToward", () => {
  it("does not move when already at target", () => {
    expect(stepGainToward(0.5, 0.5, 1 / 60)).toBe(0.5);
  });

  it("moves toward target without overshooting", () => {
    const next = stepGainToward(0, 1, 1 / 60);
    expect(next).toBeGreaterThan(0);
    expect(next).toBeLessThan(1);
  });

  it("converges over many steps at the default tau", () => {
    let gain = 0;
    for (let i = 0; i < 300; i++) {
      gain = stepGainToward(gain, 1, 1 / 60);
    }
    expect(hasGainConverged(gain, 1)).toBe(true);
  });

  it("is frame-rate independent: one big step and many small steps over the same elapsed time agree", () => {
    const totalDt = 1; // seconds
    const bigStep = stepGainToward(0, 1, totalDt, AUDIO_GAIN_TAU_SECONDS);

    const frameCount = 240; // exact step count avoids float-accumulation drift
    const frameDt = totalDt / frameCount;
    let manySteps = 0;
    for (let i = 0; i < frameCount; i++) {
      manySteps = stepGainToward(manySteps, 1, frameDt, AUDIO_GAIN_TAU_SECONDS);
    }

    expect(manySteps).toBeCloseTo(bigStep, 6);
  });

  it("returns the same value unchanged for a non-positive dt", () => {
    expect(stepGainToward(0.3, 1, 0)).toBe(0.3);
    expect(stepGainToward(0.3, 1, -1)).toBe(0.3);
  });
});

describe("hasGainConverged", () => {
  it("is false while far from target", () => {
    expect(hasGainConverged(0, 1)).toBe(false);
  });

  it("is true once within epsilon", () => {
    expect(hasGainConverged(0.999, 1)).toBe(true);
  });
});

describe("diffSubscriptions", () => {
  it("subscribes to newly-desired peers and unsubscribes from no-longer-desired ones", () => {
    const desired = new Set(["u1", "u2"]);
    const actual = new Set(["u2", "u3"]);
    const { toSubscribe, toUnsubscribe } = diffSubscriptions(desired, actual);
    expect(toSubscribe).toEqual(["u1"]);
    expect(toUnsubscribe).toEqual(["u3"]);
  });

  it("returns empty diffs when desired and actual already match", () => {
    const desired = new Set(["u1"]);
    const actual = new Set(["u1"]);
    expect(diffSubscriptions(desired, actual)).toEqual({ toSubscribe: [], toUnsubscribe: [] });
  });

  it("is idempotent to call redundantly with an unchanged state", () => {
    const desired = new Set(["u1", "u2"]);
    const actual = new Set<string>();
    const first = diffSubscriptions(desired, actual);
    // Simulate applying the diff, then reconciling again with the same desired state.
    const actualAfter = new Set(first.toSubscribe);
    const second = diffSubscriptions(desired, actualAfter);
    expect(second).toEqual({ toSubscribe: [], toUnsubscribe: [] });
  });
});

describe("desiredSubscribedPeerIds", () => {
  it("includes only peers marked audioSubscribed", () => {
    const desired: DesiredAudioState = new Map([
      ["u1", { audioSubscribed: true, audioGain: 1 }],
      ["u2", { audioSubscribed: false, audioGain: 0 }],
    ]);
    expect(desiredSubscribedPeerIds(desired)).toEqual(new Set(["u1"]));
  });

  it("is empty for an empty desired state", () => {
    expect(desiredSubscribedPeerIds(new Map())).toEqual(new Set());
  });
});
