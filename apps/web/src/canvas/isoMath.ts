import type { Point } from "@workspace-video/shared";
import { clampZoom, MIN_ZOOM, MAX_ZOOM } from "./viewportMath";

/**
 * The 2.5D view of the room: by default the flat floor is turned 45 degrees and leaned back 55
 * degrees, the same look as the owner's Gemini map (CSS rotateX(55deg) rotateZ(-45deg)). A workspace
 * may instead choose "flat" (looking straight down, no rotation at all) — an admin setting, not a
 * per-person one (docs/architecture/company-map-builder.md, D20). The server and the engine stay
 * flat either way; only the drawing changes. Every click, walk, zoom and "fit the whole floor" goes
 * through these few functions, each taking the same `tilted` flag, so a click on the picture and a
 * position on the server always agree in BOTH views.
 *
 *      flat floor (what the server knows)         on the screen, tilted            on the screen, flat
 *      (0,0) ---------> x                              /\   <- (W,0) top          (0,0) ---------> x
 *        |                                       (0,0) <    > (W,H)                 |
 *        v y                                             \/   <- (0,H) bottom       v y   (drawn straight down)
 *
 * A screen position is  position + M * floor,  with M = [a c; b d]. Nothing here draws anything.
 */

const LEAN_DEGREES = 55;
const SQUASH = Math.cos((LEAN_DEGREES * Math.PI) / 180);
const TURN = Math.SQRT1_2; // cos and sin of 45 degrees

/** x' = a*x + c*y, y' = b*x + d*y (the same layout as Pixi's Matrix). */
export interface Affine {
  a: number;
  b: number;
  c: number;
  d: number;
}

/** `tilted = false` (D20) is a plain uniform scale — no rotation, no lean — so the floor is drawn
 *  exactly as the server sees it, only bigger or smaller. `tilted = true` (the default, today's
 *  look) is unchanged. */
export function isoMatrix(scale: number, tilted = true): Affine {
  if (!tilted) return { a: scale, b: 0, c: 0, d: scale };
  return { a: scale * TURN, b: -scale * SQUASH * TURN, c: scale * TURN, d: scale * SQUASH * TURN };
}

/** Where a floor position appears on the screen. */
export function project(floor: Point, position: Point, scale: number, tilted = true): Point {
  const m = isoMatrix(scale, tilted);
  return { x: position.x + m.a * floor.x + m.c * floor.y, y: position.y + m.b * floor.x + m.d * floor.y };
}

/** Which floor position a point on the screen means (the exact reverse of `project`). */
export function unproject(screen: Point, position: Point, scale: number, tilted = true): Point {
  const m = isoMatrix(scale, tilted);
  const dx = screen.x - position.x;
  const dy = screen.y - position.y;
  const det = m.a * m.d - m.b * m.c;
  return { x: (m.d * dx - m.c * dy) / det, y: (-m.b * dx + m.a * dy) / det };
}

/** A zoom step that keeps the floor position under the cursor exactly under the cursor. */
export function zoomAtCursor(
  cursor: Point,
  position: Point,
  scale: number,
  zoomFactor: number,
  min = MIN_ZOOM,
  max = MAX_ZOOM,
  tilted = true,
): { scale: number; position: Point } {
  const underCursor = unproject(cursor, position, scale, tilted);
  const nextScale = clampZoom(scale * zoomFactor, min, max);
  const m = isoMatrix(nextScale, tilted);
  return {
    scale: nextScale,
    position: { x: cursor.x - (m.a * underCursor.x + m.c * underCursor.y), y: cursor.y - (m.b * underCursor.x + m.d * underCursor.y) },
  };
}

/**
 * The transform that cancels the tilt, for things that must stand up straight on the tilted floor: a person's dot
 * stays round and their name stays level. `atZoom` controls whether it also cancels the current zoom:
 *  - `uprightMatrix(tilted)` (atZoom defaults to 1, not the real zoom): cancels ONLY the tilt, so a person's
 *    dot still grows and shrinks with the map (Avatar.ts).
 *  - `uprightMatrix(tilted, currentZoom)`: cancels the tilt AND the zoom, so text stays a fixed size on screen no
 *    matter how far the map is zoomed — the "always 16 px on screen" rule for area names and shown name tags
 *    (D17, decision 5B). FloorView's zone labels use this; PixiStage recomputes it whenever the zoom changes.
 * In flat mode there is no tilt to cancel, so this correctly returns a plain 1/atZoom scale (isoMatrix(atZoom, false)
 * is already a plain scale with no rotation, and inverting a plain scale is still a plain scale).
 */
export function uprightMatrix(tilted = true, atZoom = 1): Affine {
  const m = isoMatrix(atZoom, tilted);
  const det = m.a * m.d - m.b * m.c;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
}

/** The zoom and position that put the whole tilted floor inside the window, centred, with a margin around it. */
export function fitFloor(
  floor: { width: number; height: number },
  view: { width: number; height: number },
  margin = 0.92,
  tilted = true,
): { scale: number; position: Point } {
  if (!(floor.width > 0 && floor.height > 0 && view.width > 0 && view.height > 0)) return { scale: 1, position: { x: 0, y: 0 } };

  const corners = [
    { x: 0, y: 0 },
    { x: floor.width, y: 0 },
    { x: 0, y: floor.height },
    { x: floor.width, y: floor.height },
  ].map((c) => project(c, { x: 0, y: 0 }, 1, tilted));
  const xs = corners.map((c) => c.x);
  const ys = corners.map((c) => c.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const scale = clampZoom(Math.min(view.width / (maxX - minX), view.height / (maxY - minY)) * margin);
  return {
    scale,
    position: { x: view.width / 2 - ((minX + maxX) / 2) * scale, y: view.height / 2 - ((minY + maxY) / 2) * scale },
  };
}
