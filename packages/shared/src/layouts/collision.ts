import type { Point } from "../geometry";
import type { FurniturePiece } from "./types";

/**
 * Real overlap check for any two pieces of furniture, any shape, any angle
 * - not the axis-aligned-bounding-box approximation furnitureGridCells uses.
 * This is what makes "you can't place a desk on top of another desk" true
 * for an admin's arbitrary drag-and-drop placement: an angled desk pod, an
 * oval table, a round lounge piece - none of them are axis-aligned, and a
 * bounding-box check would wrongly block (or wrongly allow) many real,
 * legitimate placements involving rotation.
 *
 * Uses the Separating Axis Theorem (SAT): two convex shapes do NOT overlap
 * if and only if there exists an axis along which their projections don't
 * overlap. A rectangle only needs its own two edge-normal axes tested
 * (opposite edges are parallel), so two rectangles need at most 4 axis
 * tests total - cheap enough to run on every drag-drop, every furniture
 * pair, even at 200-person layout density.
 *
 * Two pieces exactly touching edge-to-edge (e.g. two desks placed flush
 * side by side, a normal and expected admin layout) are NOT considered
 * overlapping - only real penetration is. See the `<=`/`>=` in
 * `rotatedRectsOverlap`.
 */

interface RotatedRect {
  cx: number;
  cy: number;
  halfWidth: number;
  halfHeight: number;
  /** Radians, same convention as FurniturePiece.rotation and the chair()
   *  helper in modules.ts - applied around the rect's own centre. */
  rotation: number;
}

function toRotatedRect(piece: FurniturePiece): RotatedRect {
  return {
    cx: piece.x + piece.width / 2,
    cy: piece.y + piece.height / 2,
    halfWidth: piece.width / 2,
    halfHeight: piece.height / 2,
    rotation: piece.rotation,
  };
}

function corners(r: RotatedRect): Point[] {
  const cos = Math.cos(r.rotation);
  const sin = Math.sin(r.rotation);
  const local: Array<[number, number]> = [
    [-r.halfWidth, -r.halfHeight],
    [r.halfWidth, -r.halfHeight],
    [r.halfWidth, r.halfHeight],
    [-r.halfWidth, r.halfHeight],
  ];
  return local.map(([lx, ly]) => ({
    x: r.cx + lx * cos - ly * sin,
    y: r.cy + lx * sin + ly * cos,
  }));
}

/** The two distinct edge-normal axes of a rectangle (opposite edges share
 *  an axis, so only 2 of the 4 edges need testing). Not normalized -
 *  unnecessary for a boolean overlap test, only for measuring penetration
 *  depth, which nothing here needs. */
function edgeNormalAxes(rectCorners: Point[]): Point[] {
  const axes: Point[] = [];
  for (let i = 0; i < 2; i++) {
    const p1 = rectCorners[i]!;
    const p2 = rectCorners[i + 1]!;
    axes.push({ x: -(p2.y - p1.y), y: p2.x - p1.x });
  }
  return axes;
}

function projectOntoAxis(rectCorners: Point[], axis: Point): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const c of rectCorners) {
    const dot = c.x * axis.x + c.y * axis.y;
    if (dot < min) min = dot;
    if (dot > max) max = dot;
  }
  return { min, max };
}

function rotatedRectsOverlap(a: RotatedRect, b: RotatedRect): boolean {
  const cornersA = corners(a);
  const cornersB = corners(b);
  const axes = [...edgeNormalAxes(cornersA), ...edgeNormalAxes(cornersB)];

  for (const axis of axes) {
    const projA = projectOntoAxis(cornersA, axis);
    const projB = projectOntoAxis(cornersB, axis);
    // A gap (or exact touch) on any single axis proves separation.
    if (projA.max <= projB.min || projB.max <= projA.min) return false;
  }
  return true;
}

/** True if two furniture pieces' real, rotated footprints overlap. */
export function furniturePiecesOverlap(a: FurniturePiece, b: FurniturePiece): boolean {
  return rotatedRectsOverlap(toRotatedRect(a), toRotatedRect(b));
}

/** Every piece in `existing` that `candidate` would overlap - empty means
 *  the placement is clear. Excludes a piece with the same id as `candidate`
 *  (checking a piece against a layout that already contains it, e.g. while
 *  dragging an existing piece to a new spot, isn't a self-collision). */
export function findOverlappingFurniture(candidate: FurniturePiece, existing: FurniturePiece[]): FurniturePiece[] {
  return existing.filter((piece) => piece.id !== candidate.id && furniturePiecesOverlap(candidate, piece));
}

export interface PlacementCheck {
  allowed: boolean;
  /** ids of the pieces `candidate` would overlap - empty when allowed. */
  collidesWith: string[];
}

/** The direct answer to "can the admin drop this here": checks `candidate`
 *  against every other real piece already in the layout. Reusable for any
 *  furniture kind and any shape/rotation - not specific to desks the way
 *  `deskGridFits` is to the deskGrid pattern. */
export function canPlaceFurniture(candidate: FurniturePiece, existing: FurniturePiece[]): PlacementCheck {
  const collisions = findOverlappingFurniture(candidate, existing);
  return { allowed: collisions.length === 0, collidesWith: collisions.map((piece) => piece.id) };
}
