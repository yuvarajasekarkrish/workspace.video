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
 * The transform that cancels the tilt (but not the zoom), for things that must stand up straight on the tilted
 * floor: a person's dot stays round and their name stays level, and both still grow and shrink with the map.
 * In flat mode there is no tilt to cancel, so this correctly returns the identity matrix (isoMatrix(1, false)
 * is already a plain scale with no rotation, and its own inverse is itself).
 */
export function uprightMatrix(tilted = true): Affine {
  const m = isoMatrix(1, tilted);
  const det = m.a * m.d - m.b * m.c;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
}

/**
 * A plain scale, no rotation, that lets text shrink and grow naturally with the map's own zoom
 * ABOVE `floorAt`, but never below the size it would have AT `floorAt` — a floor, not a fixed pin
 * (DESIGN.md's rule is text at LEAST 16 px, not exactly 16 px; a fixed pin made every label a
 * constant screen size regardless of the map's own scale, which looked oversized and crowded once
 * the map itself was zoomed out small — the owner's own correction, 2026-09-22). `floorAt` defaults
 * to 1 (the zoom at which a 16 px-authored label already renders as a true 16 px).
 *
 * Composed with the floor's own transform (isoMatrix(zoom, tilted)), the result is exactly
 * isoMatrix(max(zoom, floorAt), tilted) — because isoMatrix(scale, tilted) is that scale times a
 * FIXED shape (each of a/b/c/d is `scale` times a constant, so scaling by any factor lands on that
 * same shape at a different zoom). A label using this always stays angled with the floor, exactly
 * as at whichever zoom it lands on — unlike uprightMatrix, it does NOT remove the tilt.
 */
export function zoomFloorMatrix(zoom: number, floorAt = 1): Affine {
  const s = Math.max(zoom, floorAt) / zoom;
  return { a: s, b: 0, c: 0, d: s };
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
