import type { Point } from "../geometry";
import { TILE_PX } from "./grid";
import type { Seat, FurniturePiece } from "./types";

/**
 * Maps any world-px point (a seat anchor, a furniture piece's x/y) onto a
 * grid cell, and back — the piece an admin-drag builder needs to place
 * furniture in clean, aligned positions and to look up "what's near here."
 *
 * This is deliberately NOT the same thing as TileRect/TILE_PX in grid.ts:
 * that grid carves the floor into coarse zones (160px per tile, one desk
 * area might be a 6x6-tile block). This grid is fine enough to place a
 * single desk or chair inside one of those zones. FURNITURE_GRID_PX divides
 * TILE_PX evenly (160 / 20 = 8) so a furniture-grid cell never straddles a
 * zone-grid boundary — the two grids stay aligned, never independently
 * drifting relative to each other.
 *
 * Nothing here is stored: a Seat's `anchor` and a FurniturePiece's `x`/`y`
 * stay the single source of truth (used by hitTestSeats, movement, proximity,
 * rendering). A grid cell is always derived from that real position, never
 * persisted as a second, possibly-stale copy of it.
 */
export const FURNITURE_GRID_PX = 20;

export interface GridCell {
  col: number;
  row: number;
}

/** Which grid cell a world point falls into. */
export function worldToGridCell(point: Point, gridPx: number = FURNITURE_GRID_PX): GridCell {
  return { col: Math.floor(point.x / gridPx), row: Math.floor(point.y / gridPx) };
}

/** The world-px centre of a grid cell — the inverse of `worldToGridCell`. */
export function gridCellToWorld(cell: GridCell, gridPx: number = FURNITURE_GRID_PX): Point {
  return { x: cell.col * gridPx + gridPx / 2, y: cell.row * gridPx + gridPx / 2 };
}

/** Moves a point to the centre of whichever grid cell it falls in — what an
 *  admin-builder calls while dragging, so a piece dropped near a cell lands
 *  exactly on it instead of a few stray pixels off. */
export function snapToGrid(point: Point, gridPx: number = FURNITURE_GRID_PX): Point {
  return gridCellToWorld(worldToGridCell(point, gridPx), gridPx);
}

/** Which grid cell a seat's anchor falls into — read-only, derived fresh
 *  from the seat every time; never cache this on the Seat itself. */
export function seatGridCell(seat: Seat, gridPx: number = FURNITURE_GRID_PX): GridCell {
  return worldToGridCell(seat.anchor, gridPx);
}

/** Every grid cell a furniture piece's rectangle (pre-rotation) covers —
 *  its footprint on the grid, e.g. for a future "what's occupying this
 *  area" lookup. Ignores rotation: a rotated piece's true footprint is a
 *  smaller superset of this axis-aligned box, so this over-covers slightly
 *  rather than under-covering, which is the safe direction for a lookup. */
export function furnitureGridCells(piece: FurniturePiece, gridPx: number = FURNITURE_GRID_PX): GridCell[] {
  const minCell = worldToGridCell({ x: piece.x, y: piece.y }, gridPx);
  const maxCell = worldToGridCell({ x: piece.x + piece.width, y: piece.y + piece.height }, gridPx);
  const cells: GridCell[] = [];
  for (let row = minCell.row; row <= maxCell.row; row++) {
    for (let col = minCell.col; col <= maxCell.col; col++) {
      cells.push({ col, row });
    }
  }
  return cells;
}

// TILE_PX must divide evenly by FURNITURE_GRID_PX so the two grids stay
// aligned - this throws at import time (in every environment, including
// production) rather than letting the two grids silently drift apart.
if (TILE_PX % FURNITURE_GRID_PX !== 0) {
  throw new Error(`FURNITURE_GRID_PX (${FURNITURE_GRID_PX}) must divide TILE_PX (${TILE_PX}) evenly`);
}
