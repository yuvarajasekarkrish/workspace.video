import type { Point } from "@workspace-video/shared";
import { clampZoom, MIN_ZOOM, MAX_ZOOM } from "./viewportMath";

/**
 * The 2.5D view of the room: the flat floor is turned 45 degrees and leaned back 55 degrees, the same look as the
 * owner's Gemini map (CSS rotateX(55deg) rotateZ(-45deg)). The server and the engine stay flat; only the drawing
 * is tilted. Every click, walk, zoom and "fit the whole floor" goes through these few functions, so a click on the
 * tilted picture and a position on the server always agree.
 *
 *      flat floor (what the server knows)            on the screen
 *      (0,0) ---------> x                                 /\   <- (W,0) top
 *        |                                          (0,0) <    > (W,H)   the far corner, level with (0,0)
 *        v y                                                \/   <- (0,H) bottom
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

export function isoMatrix(scale: number): Affine {
  return { a: scale * TURN, b: -scale * SQUASH * TURN, c: scale * TURN, d: scale * SQUASH * TURN };
}

/** Where a floor position appears on the screen. */
export function project(floor: Point, position: Point, scale: number): Point {
  const m = isoMatrix(scale);
  return { x: position.x + m.a * floor.x + m.c * floor.y, y: position.y + m.b * floor.x + m.d * floor.y };
}

/** Which floor position a point on the screen means (the exact reverse of `project`). */
export function unproject(screen: Point, position: Point, scale: number): Point {
  const m = isoMatrix(scale);
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
): { scale: number; position: Point } {
  const underCursor = unproject(cursor, position, scale);
  const nextScale = clampZoom(scale * zoomFactor, min, max);
  const m = isoMatrix(nextScale);
  return {
    scale: nextScale,
    position: { x: cursor.x - (m.a * underCursor.x + m.c * underCursor.y), y: cursor.y - (m.b * underCursor.x + m.d * underCursor.y) },
  };
}

/**
 * The transform that cancels the tilt (but not the zoom), for things that must stand up straight on the tilted
 * floor: a person's dot stays round and their name stays level, and both still grow and shrink with the map.
 */
export function uprightMatrix(): Affine {
  const m = isoMatrix(1);
  const det = m.a * m.d - m.b * m.c;
  return { a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det };
}

/** The zoom and position that put the whole tilted floor inside the window, centred, with a margin around it. */
export function fitFloor(
  floor: { width: number; height: number },
  view: { width: number; height: number },
  margin = 0.92,
): { scale: number; position: Point } {
  if (!(floor.width > 0 && floor.height > 0 && view.width > 0 && view.height > 0)) return { scale: 1, position: { x: 0, y: 0 } };

  const corners = [
    { x: 0, y: 0 },
    { x: floor.width, y: 0 },
    { x: 0, y: floor.height },
    { x: floor.width, y: floor.height },
  ].map((c) => project(c, { x: 0, y: 0 }, 1));
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
