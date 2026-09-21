import type { Point } from "@workspace-video/shared";

// Small enough that the whole tilted floor of the biggest allowed map (50 x 50 tiles) fits a phone screen.
export const MIN_ZOOM = 0.1;
export const MAX_ZOOM = 3;
export const PAN_DRAG_THRESHOLD_PX = 5;

/** True once a pointer has moved far enough from its press point that the
 *  gesture should be treated as a pan/drag rather than a click. Shared by
 *  both the "did this become a pan" check during move and (implicitly) the
 *  "was this a click" check on release. */
export function exceedsDragThreshold(pressStart: Point, current: Point, thresholdPx = PAN_DRAG_THRESHOLD_PX): boolean {
  return Math.hypot(current.x - pressStart.x, current.y - pressStart.y) > thresholdPx;
}

export function clampZoom(scale: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  return Math.min(Math.max(scale, min), max);
}
