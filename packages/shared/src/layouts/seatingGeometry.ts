import type { FurniturePiece, RoomLayout } from "./types";
import { TILE_PX } from "./grid";
import { furniturePiecesOverlap } from "./collision";
import { renderedChairSizePx } from "./modules";

/**
 * Build-time geometry checks for layouts that use explicit table groups (Seat.tableId / FurniturePiece.seatId),
 * measured on what is actually DRAWN: a chair's drawn footprint is an axis-aligned square of renderedChairSizePx
 * around its centre (drawChair never rotates the square), which grows with visualScale while the chair's logical
 * width/height does not. Pure, no I/O, never run at request time — like validateLayout, it is called from a layout's
 * own tests. Not collision detection: nothing here affects movement or sitting.
 */

/** A chair as drawn; every other piece as stored (only chairs are visually scaled). */
export function drawnFootprint(piece: FurniturePiece): FurniturePiece {
  if (piece.kind !== "chair") return piece;
  const size = renderedChairSizePx(piece.visualScale ?? 1);
  const cx = piece.x + piece.width / 2;
  const cy = piece.y + piece.height / 2;
  return { ...piece, x: cx - size / 2, y: cy - size / 2, width: size, height: size, rotation: 0 };
}

function gapBetween(a: { x: number; y: number; width: number; height: number }, b: typeof a): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

function bounds(pieces: FurniturePiece[]) {
  const x0 = Math.min(...pieces.map((p) => p.x));
  const y0 = Math.min(...pieces.map((p) => p.y));
  const x1 = Math.max(...pieces.map((p) => p.x + p.width));
  const y1 = Math.max(...pieces.map((p) => p.y + p.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

export interface SeatingGeometryOptions {
  /** Minimum empty floor, in world px, between two table groups' drawn footprints (table plus its chairs). */
  minWalkwayPx: number;
  /** Minimum gap, in world px, between a drawn chair and ANY table (its own included). */
  minChairTableGapPx: number;
}

/** Every problem found; empty means the layout's explicit seating geometry is sound. */
export function checkSeatingGeometry(layout: RoomLayout, opts: SeatingGeometryOptions): string[] {
  const issues: string[] = [];
  const floorW = layout.floor.cols * TILE_PX;
  const floorH = layout.floor.rows * TILE_PX;
  const pieceById = new Map(layout.furniture.map((f) => [f.id, f]));
  const seatById = new Map(layout.seats.map((s) => [s.id, s]));
  const chairs = layout.furniture.filter((f) => f.kind === "chair");
  const tables = layout.furniture.filter((f) => f.kind === "table" || f.kind === "desk");

  // Mapping: seat -> table, chair -> seat, one chair per seat, seat anchor on the chair's centre.
  const chairsBySeat = new Map<string, FurniturePiece[]>();
  for (const c of chairs) {
    if (c.seatId === undefined) continue;
    if (!seatById.has(c.seatId)) issues.push(`Chair "${c.id}" names seat "${c.seatId}", which does not exist`);
    chairsBySeat.set(c.seatId, [...(chairsBySeat.get(c.seatId) ?? []), c]);
  }
  for (const s of layout.seats) {
    if (s.tableId === undefined) continue;
    const table = pieceById.get(s.tableId);
    if (!table || (table.kind !== "table" && table.kind !== "desk")) issues.push(`Seat "${s.id}" names table "${s.tableId}", which is not a table`);
    const own = chairsBySeat.get(s.id) ?? [];
    if (own.length !== 1) {
      issues.push(`Seat "${s.id}" has ${own.length} chairs (expected exactly 1)`);
      continue;
    }
    const c = own[0]!;
    const cx = c.x + c.width / 2;
    const cy = c.y + c.height / 2;
    if (Math.abs(cx - s.anchor.x) > 1e-9 || Math.abs(cy - s.anchor.y) > 1e-9) issues.push(`Seat "${s.id}" anchor is not at its chair's centre`);
  }

  // Drawn overlap: chair/chair, chair/table (with a minimum gap), table/table.
  const drawn = chairs.map(drawnFootprint);
  for (let i = 0; i < drawn.length; i++) {
    for (let j = i + 1; j < drawn.length; j++) {
      if (furniturePiecesOverlap(drawn[i]!, drawn[j]!)) issues.push(`Chairs "${drawn[i]!.id}" and "${drawn[j]!.id}" overlap`);
    }
    for (const t of tables) {
      const gap = gapBetween(drawn[i]!, t);
      if (gap < opts.minChairTableGapPx) issues.push(`Chair "${drawn[i]!.id}" is ${gap.toFixed(1)}px from table "${t.id}" (min ${opts.minChairTableGapPx})`);
    }
  }
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      if (furniturePiecesOverlap(tables[i]!, tables[j]!)) issues.push(`Tables "${tables[i]!.id}" and "${tables[j]!.id}" overlap`);
    }
  }

  // Walkways between table groups (the table plus its chairs, as drawn).
  const groups = new Map<string, FurniturePiece[]>();
  for (const s of layout.seats) {
    if (s.tableId === undefined) continue;
    const table = pieceById.get(s.tableId);
    const chair = chairsBySeat.get(s.id)?.[0];
    if (!table || !chair) continue;
    const members = groups.get(s.tableId) ?? [table];
    members.push(drawnFootprint(chair));
    groups.set(s.tableId, members);
  }
  const groupBoxes = [...groups.entries()].map(([id, members]) => ({ id, box: bounds(members) }));
  for (let i = 0; i < groupBoxes.length; i++) {
    for (let j = i + 1; j < groupBoxes.length; j++) {
      const gap = gapBetween(groupBoxes[i]!.box, groupBoxes[j]!.box);
      if (gap < opts.minWalkwayPx) issues.push(`Table groups "${groupBoxes[i]!.id}" and "${groupBoxes[j]!.id}" are ${gap.toFixed(1)}px apart (min ${opts.minWalkwayPx})`);
    }
  }

  // Everything drawn stays on the floor.
  for (const piece of layout.furniture.map(drawnFootprint)) {
    if (piece.x < 0 || piece.y < 0 || piece.x + piece.width > floorW || piece.y + piece.height > floorH) {
      issues.push(`"${piece.id}" is drawn outside the floor`);
    }
  }
  return issues;
}
