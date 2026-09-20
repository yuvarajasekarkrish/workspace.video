import { describe, it, expect } from "vitest";
import { computeProximityState, tickProximity, pairKey } from "../proximity.js";
import { DEFAULT_PROXIMITY_CONFIG } from "@workspace-video/shared";

const cfg = DEFAULT_PROXIMITY_CONFIG; // video=200, audio=500, hysteresis=25

describe("computeProximityState", () => {
  it("is fully engaged at distance 0", () => {
    const s = computeProximityState(0, undefined, cfg);
    expect(s).toEqual({ audioSubscribed: true, audioGain: 1, videoSubscribed: true });
  });

  it("subscribes video and full gain exactly at the video radius", () => {
    const s = computeProximityState(200, undefined, cfg);
    expect(s.videoSubscribed).toBe(true);
    expect(s.audioGain).toBe(1);
  });

  it("is audio-only, gain-ramped, just past the video radius", () => {
    const s = computeProximityState(201, undefined, cfg);
    expect(s.videoSubscribed).toBe(false);
    expect(s.audioSubscribed).toBe(true);
    expect(s.audioGain).toBeCloseTo(1 - 1 / 300, 5);
  });

  it("gain reaches 0 at the audio radius midpoint and endpoint", () => {
    const mid = computeProximityState(350, undefined, cfg);
    expect(mid.audioGain).toBeCloseTo(0.5, 5);

    const end = computeProximityState(500, undefined, cfg);
    expect(end.audioGain).toBeCloseTo(0, 5);
    expect(end.audioSubscribed).toBe(true);
  });

  it("unsubscribes entirely beyond the audio radius", () => {
    const s = computeProximityState(501, undefined, cfg);
    expect(s).toEqual({ audioSubscribed: false, audioGain: 0, videoSubscribed: false });
  });

  describe("hysteresis", () => {
    it("does not drop video subscription just past the radius if already subscribed", () => {
      const engaged = computeProximityState(150, undefined, cfg); // videoSubscribed: true
      const stillClose = computeProximityState(210, engaged, cfg); // within 200+25
      expect(stillClose.videoSubscribed).toBe(true);
    });

    it("drops video subscription once past radius + hysteresis", () => {
      const engaged = computeProximityState(150, undefined, cfg);
      const farEnough = computeProximityState(226, engaged, cfg); // > 200+25
      expect(farEnough.videoSubscribed).toBe(false);
    });

    it("does not re-subscribe video on the outward edge without crossing back within radius", () => {
      // never subscribed (started far away), now sitting inside the hysteresis band
      // but still outside the true radius -> should NOT gain video subscription.
      const neverSubscribed = computeProximityState(210, undefined, cfg);
      expect(neverSubscribed.videoSubscribed).toBe(false);
    });

    it("does not drop audio subscription just past the audio radius if already subscribed", () => {
      const engaged = computeProximityState(480, undefined, cfg); // audioSubscribed: true
      const stillIn = computeProximityState(520, engaged, cfg); // within 500+25
      expect(stillIn.audioSubscribed).toBe(true);
    });

    it("drops audio subscription once past audio radius + hysteresis", () => {
      const engaged = computeProximityState(480, undefined, cfg);
      const farEnough = computeProximityState(526, engaged, cfg);
      expect(farEnough.audioSubscribed).toBe(false);
    });
  });
});

describe("pairKey", () => {
  it("is order-independent", () => {
    expect(pairKey("a", "b")).toBe(pairKey("b", "a"));
  });
});

describe("tickProximity", () => {
  it("emits no changes when nothing has moved and state is unchanged", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 100, y: 0 }],
    ]);
    const first = tickProximity(positions, new Map(), cfg);
    expect(first).toHaveLength(1); // first tick always reports (no previous state)

    const previousStates = new Map(first.map((c) => [pairKey(c.a, c.b), c.state]));
    const second = tickProximity(positions, previousStates, cfg);
    expect(second).toHaveLength(0);
  });

  it("emits a change only for the pair whose distance actually crossed a threshold", () => {
    const positions = new Map([
      ["a", { x: 0, y: 0 }],
      ["b", { x: 100, y: 0 }],
      ["c", { x: 10000, y: 10000 }],
    ]);
    const first = tickProximity(positions, new Map(), cfg);
    const previousStates = new Map(first.map((c) => [pairKey(c.a, c.b), c.state]));

    // Move b away from a, past the audio radius; c stays put and out of range.
    positions.set("b", { x: 10000, y: 0 });
    const second = tickProximity(positions, previousStates, cfg);

    const changedKeys = second.map((c) => pairKey(c.a, c.b));
    expect(changedKeys).toContain(pairKey("a", "b"));
    expect(changedKeys).not.toContain(pairKey("a", "c"));
    expect(changedKeys).not.toContain(pairKey("b", "c"));
  });
});
