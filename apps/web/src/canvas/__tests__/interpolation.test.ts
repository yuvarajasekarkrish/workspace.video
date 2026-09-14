import { describe, it, expect } from "vitest";
import { stepToward, hasConverged, DEFAULT_INTERPOLATION_TAU_SECONDS } from "../interpolation";

describe("stepToward", () => {
  it("does not move when render already equals target", () => {
    const p = { x: 10, y: 10 };
    expect(stepToward(p, p, 1 / 60)).toEqual(p);
  });

  it("moves toward target, never overshooting it", () => {
    const render = { x: 0, y: 0 };
    const target = { x: 100, y: 0 };
    const next = stepToward(render, target, 1 / 60);
    expect(next.x).toBeGreaterThan(0);
    expect(next.x).toBeLessThan(100);
  });

  it("converges to target over many steps", () => {
    let render = { x: 0, y: 0 };
    const target = { x: 100, y: 50 };
    for (let i = 0; i < 600; i++) {
      render = stepToward(render, target, 1 / 60);
    }
    expect(hasConverged(render, target)).toBe(true);
  });

  it("never overshoots across many small steps either", () => {
    let render = { x: 0, y: 0 };
    const target = { x: 100, y: 0 };
    for (let i = 0; i < 300; i++) {
      render = stepToward(render, target, 1 / 60);
      expect(render.x).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it("returns the same point unchanged for a non-positive dt", () => {
    const render = { x: 5, y: 5 };
    const target = { x: 10, y: 10 };
    expect(stepToward(render, target, 0)).toEqual(render);
    expect(stepToward(render, target, -1)).toEqual(render);
  });

  it("is frame-rate independent: one big step ~= many small steps over the same elapsed time", () => {
    // Repeated application telescopes exactly: remaining distance multiplies
    // by e^(-dt/tau) each call, so N steps of dt should equal one step of
    // N*dt up to floating-point precision — PROVIDED the total elapsed time
    // matches exactly. A `while (elapsed < totalDt) elapsed += frameDt` loop
    // is the wrong way to test that: float summation drift can make the
    // loop run one extra (or one too few) iteration, which changes the
    // actual elapsed time being compared rather than testing frame-rate
    // independence. Use a fixed, exact step count instead.
    const render = { x: 0, y: 0 };
    const target = { x: 100, y: 100 };
    const totalDt = 0.5; // half a second of elapsed wall time

    const oneStep = stepToward(render, target, totalDt);

    let manySteps = { ...render };
    const frameCount = 120; // 240Hz for exactly totalDt seconds
    const frameDt = totalDt / frameCount;
    for (let i = 0; i < frameCount; i++) {
      manySteps = stepToward(manySteps, target, frameDt);
    }

    expect(manySteps.x).toBeCloseTo(oneStep.x, 6);
    expect(manySteps.y).toBeCloseTo(oneStep.y, 6);
  });

  it("60Hz and 144Hz stepping reach the same position after the same elapsed time", () => {
    // Same fixed-step-count reasoning as above: derive each frame's dt from
    // an exact frame count for the target elapsed time, rather than
    // accumulating dt in a loop guard, so both simulations cover identically
    // the same elapsed time and any residual difference reflects a real
    // frame-rate dependency rather than loop-boundary float drift.
    const target = { x: 100, y: 0 };
    const totalDt = 0.3;

    function simulate(hz: number) {
      let p = { x: 0, y: 0 };
      const frameCount = Math.round(totalDt * hz);
      const dt = totalDt / frameCount;
      for (let i = 0; i < frameCount; i++) {
        p = stepToward(p, target, dt);
      }
      return p;
    }

    const at60 = simulate(60);
    const at144 = simulate(144);
    expect(at60.x).toBeCloseTo(at144.x, 6);
  });

  it("respects a custom tau — smaller tau converges faster", () => {
    const render = { x: 0, y: 0 };
    const target = { x: 100, y: 0 };
    const fast = stepToward(render, target, 1 / 60, DEFAULT_INTERPOLATION_TAU_SECONDS / 2);
    const slow = stepToward(render, target, 1 / 60, DEFAULT_INTERPOLATION_TAU_SECONDS * 2);
    expect(fast.x).toBeGreaterThan(slow.x);
  });
});

describe("hasConverged", () => {
  it("is false when far apart", () => {
    expect(hasConverged({ x: 0, y: 0 }, { x: 10, y: 10 })).toBe(false);
  });

  it("is true when within epsilon", () => {
    expect(hasConverged({ x: 10, y: 10 }, { x: 10.01, y: 10.01 })).toBe(true);
  });
});
