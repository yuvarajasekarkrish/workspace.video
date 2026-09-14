import type { Point } from "@cosmos/shared";

export const MIN_ZOOM = 0.25;
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

/** Converts a screen-space point to world-space, given the world
 *  container's current position and uniform scale. */
export function screenToWorld(screen: Point, worldPosition: Point, scale: number): Point {
  return {
    x: (screen.x - worldPosition.x) / scale,
    y: (screen.y - worldPosition.y) / scale,
  };
}

/**
 * Computes the new world scale + position for a cursor-anchored zoom step,
 * clamped to [min, max]: the world point currently under the cursor stays
 * under the cursor after the zoom, which is what makes wheel-zoom feel
 * anchored rather than always re-centering on the origin.
 */
export function computeCursorAnchoredZoom(
  cursorScreen: Point,
  worldPosition: Point,
  currentScale: number,
  zoomFactor: number,
  min = MIN_ZOOM,
  max = MAX_ZOOM,
): { scale: number; position: Point } {
  const worldPointUnderCursor = screenToWorld(cursorScreen, worldPosition, currentScale);
  const newScale = clampZoom(currentScale * zoomFactor, min, max);

  return {
    scale: newScale,
    position: {
      x: cursorScreen.x - worldPointUnderCursor.x * newScale,
      y: cursorScreen.y - worldPointUnderCursor.y * newScale,
    },
  };
}
