import { describe, it, expect } from "vitest";
import {
  FURNITURE_GRID_PX,
  worldToGridCell,
  gridCellToWorld,
  snapToGrid,
  seatGridCell,
  furnitureGridCells,
} from "../furnitureGrid";
import { TILE_PX } from "../grid";
import type { Seat, FurniturePiece } from "../types";

describe("FURNITURE_GRID_PX", () => {
  it("divides TILE_PX evenly, so the furniture grid never drifts from the zone grid", () => {
    expect(TILE_PX % FURNITURE_GRID_PX).toBe(0);
  });
});

describe("worldToGridCell / gridCellToWorld", () => {
  it("maps a point to its cell and back to that cell's centre", () => {
    const cell = worldToGridCell({ x: 45, y: 105 });
    expect(cell).toEqual({ col: 2, row: 5 }); // 45/20=2.25->2, 105/20=5.25->5
    expect(gridCellToWorld(cell)).toEqual({ x: 50, y: 110 }); // cell centre
  });

  it("round-trips a cell centre exactly", () => {
    const cell = { col: 7, row: 3 };
    const centre = gridCellToWorld(cell);
    expect(worldToGridCell(centre)).toEqual(cell);
  });

  it("respects a custom grid size", () => {
    expect(worldToGridCell({ x: 99, y: 1 }, 100)).toEqual({ col: 0, row: 0 });
    expect(worldToGridCell({ x: 100, y: 1 }, 100)).toEqual({ col: 1, row: 0 });
  });

  it("handles the origin and negative-adjacent boundary correctly", () => {
    expect(worldToGridCell({ x: 0, y: 0 })).toEqual({ col: 0, row: 0 });
    expect(worldToGridCell({ x: 19.999, y: 0 })).toEqual({ col: 0, row: 0 });
    expect(worldToGridCell({ x: 20, y: 0 })).toEqual({ col: 1, row: 0 });
  });
});

describe("snapToGrid", () => {
  it("moves an arbitrary point to its cell's centre", () => {
    expect(snapToGrid({ x: 123, y: 47 })).toEqual({ x: 130, y: 50 });
  });

  it("leaves an already-centred point unchanged", () => {
    const centre = { x: 50, y: 110 };
    expect(snapToGrid(centre)).toEqual(centre);
  });

  it("snaps a real production seat anchor (Desk 1's chair-a, from deskGrid's own math) predictably", () => {
    // deskGrid places chair-a at cx - chairGap; for a desk centred at (80,80)
    // with chairGap=63, that's (17, 80) - a real, not invented, anchor.
    const anchor = { x: 17, y: 80 };
    expect(snapToGrid(anchor)).toEqual({ x: 10, y: 90 });
  });
});

describe("seatGridCell", () => {
  it("derives the cell from the seat's anchor, never a stored field", () => {
    const seat: Seat = { id: "desk-1-a", label: "Desk 1", anchor: { x: 17, y: 80 } };
    expect(seatGridCell(seat)).toEqual(worldToGridCell(seat.anchor));
  });
});

describe("furnitureGridCells", () => {
  it("covers every cell a desk's footprint touches", () => {
    // A 76x76 desk at (42,42): spans x/y 42..118, i.e. grid cells 2..5 (40..119).
    const desk: FurniturePiece = { id: "d1", kind: "desk", x: 42, y: 42, width: 76, height: 76, rotation: 0 };
    const cells = furnitureGridCells(desk);
    expect(cells).toContainEqual({ col: 2, row: 2 });
    expect(cells).toContainEqual({ col: 5, row: 5 });
    expect(cells).toHaveLength(4 * 4); // cols 2-5, rows 2-5
  });

  it("returns exactly one cell for a piece smaller than the grid size", () => {
    const chair: FurniturePiece = { id: "c1", kind: "chair", x: 5, y: 5, width: 10, height: 10, rotation: 0 };
    expect(furnitureGridCells(chair)).toEqual([{ col: 0, row: 0 }]);
  });
});
