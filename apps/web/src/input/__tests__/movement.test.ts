import { describe, it, expect } from "vitest";
import {
  clampToBounds,
  integrateKeyboardMove,
  stepTowardWalkTarget,
  shouldEmitMove,
  WALK_SPEED_PX_PER_SEC,
} from "../movement";
import { DEFAULT_MOVEMENT_CONFIG } from "@workspace-video/shared";

describe("WALK_SPEED_PX_PER_SEC", () => {
  it("is comfortably under the server's max speed so ordinary play never trips a correction", () => {
    expect(WALK_SPEED_PX_PER_SEC).toBeLessThan(DEFAULT_MOVEMENT_CONFIG.maxSpeedPxPerSec / 2);
  });
});

describe("clampToBounds", () => {
  it("passes through an in-bounds point unchanged", () => {
    expect(clampToBounds({ x: 100, y: 200 })).toEqual({ x: 100, y: 200 });
  });

  it("clamps negative coordinates to 0", () => {
    expect(clampToBounds({ x: -50, y: -1 })).toEqual({ x: 0, y: 0 });
  });

  it("clamps coordinates beyond room bounds", () => {
    const bounds = DEFAULT_MOVEMENT_CONFIG;
    expect(clampToBounds({ x: bounds.roomWidthPx + 500, y: bounds.roomHeightPx + 500 })).toEqual({
      x: bounds.roomWidthPx,
      y: bounds.roomHeightPx,
    });
  });
});

describe("integrateKeyboardMove", () => {
  it("does not move when direction is zero", () => {
    const p = { x: 10, y: 10 };
    expect(integrateKeyboardMove(p, { x: 0, y: 0 }, 1 / 60)).toEqual(p);
  });

  it("moves at WALK_SPEED_PX_PER_SEC along a single axis", () => {
    const next = integrateKeyboardMove({ x: 0, y: 0 }, { x: 1, y: 0 }, 1);
    expect(next.x).toBeCloseTo(WALK_SPEED_PX_PER_SEC, 5);
    expect(next.y).toBeCloseTo(0, 5);
  });

  it("normalizes diagonal input so it isn't faster than axis-aligned movement", () => {
    const diagonal = integrateKeyboardMove({ x: 0, y: 0 }, { x: 1, y: 1 }, 1);
    const distance = Math.hypot(diagonal.x, diagonal.y);
    expect(distance).toBeCloseTo(WALK_SPEED_PX_PER_SEC, 5);
  });

  it("clamps to bounds when integrating past an edge", () => {
    const bounds = DEFAULT_MOVEMENT_CONFIG;
    const next = integrateKeyboardMove(
      { x: bounds.roomWidthPx - 1, y: 0 },
      { x: 1, y: 0 },
      1,
      bounds,
    );
    expect(next.x).toBe(bounds.roomWidthPx);
  });
});

describe("stepTowardWalkTarget", () => {
  it("does not overshoot a close target", () => {
    const target = { x: 5, y: 0 };
    const next = stepTowardWalkTarget({ x: 0, y: 0 }, target, 1); // 1s of travel, target is 5px away
    expect(next).toEqual(target);
  });

  it("moves at WALK_SPEED_PX_PER_SEC toward a far target without reaching it early", () => {
    const target = { x: 10_000, y: 0 };
    const next = stepTowardWalkTarget({ x: 0, y: 0 }, target, 1);
    expect(next.x).toBeCloseTo(WALK_SPEED_PX_PER_SEC, 5);
  });

  it("reaches the exact target after enough elapsed time", () => {
    let pos = { x: 0, y: 0 };
    const target = { x: 200, y: 150 };
    for (let i = 0; i < 600; i++) {
      pos = stepTowardWalkTarget(pos, target, 1 / 60);
    }
    expect(pos).toEqual(target);
  });
});

describe("shouldEmitMove", () => {
  const cfg = DEFAULT_MOVEMENT_CONFIG; // clientThrottleMs: 50

  it("always emits the first move (no prior sent state)", () => {
    expect(shouldEmitMove(null, null, 1000, { x: 1, y: 1 }, cfg)).toBe(true);
  });

  it("does not emit when the position is unchanged, regardless of elapsed time", () => {
    const pos = { x: 5, y: 5 };
    expect(shouldEmitMove(1000, pos, 5000, pos, cfg)).toBe(false);
  });

  it("does not emit a changed position before the throttle interval has elapsed", () => {
    expect(shouldEmitMove(1000, { x: 0, y: 0 }, 1020, { x: 1, y: 1 }, cfg)).toBe(false);
  });

  it("emits a changed position once the throttle interval has elapsed", () => {
    expect(shouldEmitMove(1000, { x: 0, y: 0 }, 1050, { x: 1, y: 1 }, cfg)).toBe(true);
  });

  it("emits exactly at the throttle boundary", () => {
    expect(shouldEmitMove(1000, { x: 0, y: 0 }, 1000 + cfg.clientThrottleMs, { x: 1, y: 1 }, cfg)).toBe(
      true,
    );
  });
});
