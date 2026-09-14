import { describe, it, expect } from "vitest";
import { validateMove } from "../movement.js";
import { DEFAULT_MOVEMENT_CONFIG } from "@cosmos/shared";

const cfg = DEFAULT_MOVEMENT_CONFIG; // maxSpeed=2000px/s, bounds 8000x8000

describe("validateMove", () => {
  const base = { position: { x: 100, y: 100 }, acceptedAtMs: 1000 };

  it("accepts a small move within the speed limit", () => {
    const r = validateMove({ x: 105, y: 100 }, base, 1050, cfg); // 5px in 50ms = 100px/s
    expect(r.accepted).toBe(true);
  });

  it("rejects non-finite coordinates as invalid", () => {
    const r = validateMove({ x: NaN, y: 5 }, base, 1050, cfg);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe("invalid");
      expect(r.correctedPosition).toEqual(base.position);
    }
  });

  it("rejects Infinity as invalid", () => {
    const r = validateMove({ x: Infinity, y: 5 }, base, 1050, cfg);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("invalid");
  });

  it("rejects and clamps out-of-bounds coordinates", () => {
    const r = validateMove({ x: -50, y: 9000 }, base, 1050, cfg);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe("out_of_bounds");
      expect(r.correctedPosition).toEqual({ x: 0, y: cfg.roomHeightPx });
    }
  });

  it("rejects a move implying speed over the max as max_speed_exceeded", () => {
    // 5000px in 50ms = 100,000 px/s, way over 2000 px/s
    const r = validateMove({ x: 5100, y: 100 }, base, 1050, cfg);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe("max_speed_exceeded");
      expect(r.correctedPosition).toEqual(base.position);
    }
  });

  it("accepts a large move if enough time has elapsed to justify the speed", () => {
    // 1000px over 1 full second = 1000px/s, under the 2000px/s cap
    const r = validateMove({ x: 1100, y: 100 }, base, 2000, cfg);
    expect(r.accepted).toBe(true);
  });

  it("does not divide by ~zero elapsed time into a false accept", () => {
    // huge jump with (near) zero elapsed time must be rejected, not accepted
    // via an unbounded allowance.
    const r = validateMove({ x: 7900, y: 100 }, base, 1000, cfg);
    expect(r.accepted).toBe(false);
  });
});
