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

/**
 * Space the floor must keep clear of when it is fitted, so it never sits under the room's floating controls: the
 * room name and status pills along the top, the people list and zoom buttons at the sides, and the bottom dock.
 * On a narrow (phone) screen the side panels are hidden, so only a small gutter is kept at the sides.
 */
export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export function fitInsets(view: { width: number; height: number }): Insets {
  const narrow = view.width < 700;
  // Top: the connection and online pills at the top left (two rows). Left: the map runs to the edge below them.
  // Right: the current area chip, the "In this room" list (about 190 px) and the zoom buttons.
  return { top: 84, bottom: 92, left: 16, right: narrow ? 16 : 214 };
}

/** How far in past the fitted view a person may zoom (the fitted view is the furthest out). */
export const MAX_ZOOM_OVER_FIT = 3;

/** Floor drawn around the layout on every side (FloorView) and included in the fit (Viewport), in floor pixels. */
export const FLOOR_MARGIN = 24;
