/**
 * Frame-rate-independent exponential smoothing for remote avatar positions.
 * Remote avatars never snap to their latest server position — they carry a
 * `render` position (what's drawn) and a `target` (last known-good server
 * position), and the ticker advances `render` toward `target` every frame.
 *
 * A naive fixed-alpha lerp (`render += (target - render) * alpha`) is
 * NOT frame-rate independent: applied once per frame, it converges faster
 * on a 144Hz display than a 60Hz one for the same alpha, because more
 * frames execute per second of wall time. The exponential form below
 * instead converges at the same *rate per unit of elapsed time* regardless
 * of how many (or how uneven) frames it's stepped across — verified in
 * interpolation.test.ts by comparing one large dt step against many small
 * steps covering the same total elapsed time.
 */

import type { Point } from "@cosmos/shared";

export type Vec2 = Point;

/** `tau` is the time constant in seconds: roughly how long it takes to close
 *  ~63% of the remaining distance. Smaller = snappier, larger = smoother. */
export const DEFAULT_INTERPOLATION_TAU_SECONDS = 0.1;

/**
 * Advances `render` toward `target` by one time step of `dtSeconds`.
 * Pure — returns a new point, does not mutate its inputs.
 */
export function stepToward(
  render: Vec2,
  target: Vec2,
  dtSeconds: number,
  tauSeconds: number = DEFAULT_INTERPOLATION_TAU_SECONDS,
): Vec2 {
  if (dtSeconds <= 0) return render;
  // 1 - e^(-dt/tau): fraction of the remaining distance closed this step.
  const alpha = 1 - Math.exp(-dtSeconds / tauSeconds);
  return {
    x: render.x + (target.x - render.x) * alpha,
    y: render.y + (target.y - render.y) * alpha,
  };
}

/** True once `render` is close enough to `target` that further stepping is
 *  imperceptible — lets the caller stop animating a settled avatar. */
export function hasConverged(render: Vec2, target: Vec2, epsilon = 0.05): boolean {
  return Math.abs(render.x - target.x) < epsilon && Math.abs(render.y - target.y) < epsilon;
}
