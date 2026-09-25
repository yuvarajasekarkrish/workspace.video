import type { Point } from "../geometry";
import type { FurniturePiece, LayoutZone, Seat, TileRect } from "./types";
import { TILE_PX, tileRectToWorld } from "./grid";

export interface ModuleResult {
  furniture: FurniturePiece[];
  seats: Seat[];
  zones: LayoutZone[];
}

function empty(): ModuleResult {
  return { furniture: [], seats: [], zones: [] };
}

function merge(...parts: ModuleResult[]): ModuleResult {
  return {
    furniture: parts.flatMap((p) => p.furniture),
    seats: parts.flatMap((p) => p.seats),
    zones: parts.flatMap((p) => p.zones),
  };
}

// Both raised slightly for visibility (owner request). Bounded by deskGrid's own 160px cell
// (TILE_PX in grid.ts), the tightest allocation in the whole layout - every other block gets a
// multi-tile box with much more room. With the old sizes, a desk pair's two chairs already spanned
// 148px of that 160px cell (12px slack). 76/34 spans 156px (4px slack, 2px each side) - the most
// headroom allows without risking a chair visually reaching into the next desk's cell. Checked
// every other block's own box in openOffice.ts before picking these numbers: all of them (bench
// tables, private cabins, collab tables, the kitchen) get a box several tiles wide, so this same
// increase leaves them with far more room than deskGrid, never less.
const DESK_SIZE = 76;
const CHAIR_SIZE = 34;
const PLANT_SIZE = 28;

/** `faceX`/`faceY`: the point this chair's seat faces (almost always its own desk/table
 *  centre) - every call site already knows this point, since it placed the chair relative
 *  to it. `rotation` is the angle from the chair to that point: the same rule proven correct
 *  on the 4-seat table (each seat's rotation independently verified against its own facing
 *  direction) made general, not a new one - a chair with no real facing point (there are
 *  none left after this change) would simply keep facing right (rotation 0).
 *
 *  `visualScale` (optional) is passed straight through to the returned piece's
 *  `visualScale` field — it never changes `x`/`y`/`width`/`height` here, so a
 *  caller passing a scale gets a bigger/smaller DRAWING at the exact same
 *  logical position and footprint every caller that omits it already gets.
 *  Omitted entirely (not even set to `1`) when the caller doesn't pass one,
 *  so an existing call site (deskGrid without chairVisualScale, every other
 *  generator) produces a byte-identical FurniturePiece to before this
 *  parameter existed. */
function chair(id: string, x: number, y: number, faceX: number, faceY: number, visualScale?: number): FurniturePiece {
  const rotation = Math.atan2(faceY - y, faceX - x);
  return {
    id,
    kind: "chair",
    x: x - CHAIR_SIZE / 2,
    y: y - CHAIR_SIZE / 2,
    width: CHAIR_SIZE,
    height: CHAIR_SIZE,
    rotation,
    ...(visualScale !== undefined ? { visualScale } : {}),
  };
}

function plant(id: string, x: number, y: number): FurniturePiece {
  return { id, kind: "plant", x: x - PLANT_SIZE / 2, y: y - PLANT_SIZE / 2, width: PLANT_SIZE, height: PLANT_SIZE, rotation: 0 };
}

/**
 * A grid of square, two-person desks — chairs left and right of each desk,
 * matching the approved floor design (never a rectangular multi-seat bench
 * for a two-person desk). Numbered left-to-right, top-to-bottom starting at
 * `startNumber`; each desk contributes two independently claimable seats
 * (`desk-<n>-a`/`-b`) sharing the same "Desk <n>" label, since the label
 * identifies the physical desk, not a specific chair.
 */
/** The smallest cell `deskGrid` can place a desk-and-two-chairs unit into
 *  without the chairs overlapping the next cell — same formula as `deskGrid`
 *  itself (`chairGap` below), not a separately-guessed number. Horizontal
 *  needs room for both side chairs; vertical only needs the desk's own
 *  footprint, since chairs sit left/right and CHAIR_SIZE < DESK_SIZE. */
const MIN_DESK_CELL_WIDTH = DESK_SIZE + CHAIR_SIZE + 12; // 2x chairGap
const MIN_DESK_CELL_HEIGHT = DESK_SIZE;

export interface DeskGridFit {
  fits: boolean;
  /** Missing when `fits` is true. */
  reason?: "cell_too_narrow" | "cell_too_short";
  cellPx: { width: number; height: number };
  minPx: { width: number; height: number };
}

/**
 * Checks whether a requested `cols x rows` of two-person desks fits inside
 * `rect` without desks or their chairs overlapping the next cell over —
 * the check `deskGrid` itself doesn't do (it blindly divides the box and
 * places furniture, per the architecture doc's own "furniture is drawing
 * only with no collision" gap). Exists so an admin choosing an arbitrary
 * desk count/shape for a tile allocation (2x40, 3x6, anything) gets a real
 * yes/no answer before that arrangement is ever built, instead of finding
 * out from overlapping chairs on screen. Pure math, no I/O, same
 * `TileRect`/`opts` shape `deskGrid` itself takes so the two are always
 * called with the exact same inputs.
 */
export function deskGridFits(rect: TileRect, opts: { cols: number; rows: number }): DeskGridFit {
  const box = tileRectToWorld(rect);
  const cellPx = { width: box.width / opts.cols, height: box.height / opts.rows };
  const minPx = { width: MIN_DESK_CELL_WIDTH, height: MIN_DESK_CELL_HEIGHT };

  if (cellPx.width < minPx.width) return { fits: false, reason: "cell_too_narrow", cellPx, minPx };
  if (cellPx.height < minPx.height) return { fits: false, reason: "cell_too_short", cellPx, minPx };
  return { fits: true, cellPx, minPx };
}

/** Must match apps/web/src/canvas/furniture3d.ts's drawChair — `s = min(c.width,
 *  c.height) * CHAIR_RENDER_FACTOR * (visualScale ?? 1)` is the actual on-screen
 *  chair size. Duplicated here (rather than imported) because packages/shared
 *  has no dependency on the web app's canvas rendering code, and shouldn't
 *  gain one just for a single shared literal — this constant is deliberately
 *  small and stable (a cosmetic "how snug the chair sits in its own
 *  footprint" ratio, not something a template would ever want to change),
 *  so the duplication risk is low, but it IS a real coupling: if drawChair's
 *  0.92 ever changes, this must change with it or the overlap warning below
 *  will silently drift out of sync with what's actually rendered. */
const CHAIR_RENDER_FACTOR = 0.92;

export interface ChairOverlapRisk {
  requestedScale: number;
  /** Half the chair's actual on-screen size at `requestedScale`, in px —
   *  what would need to fit within availableSlackPx of the desk's own
   *  (unscaled) half-footprint to avoid visually reaching into the next
   *  desk's cell. */
  renderedChairHalfSizePx: number;
  /** How much room, in px, exists today (at visualScale 1) between the
   *  chair's own edge and the cell boundary — deskGrid's real, current
   *  margin, computed from the same DESK_SIZE/CHAIR_SIZE constants
   *  deskGridFits and chairGap use, not a separately-guessed number. */
  availableSlackPx: number;
  /** True when a chair drawn at `requestedScale` would visually reach past
   *  the cell boundary into the neighboring desk's space. This is a
   *  reporting-only signal — see this function's own docs — never a
   *  clamp: the caller decides what to do with a risky scale. */
  overlapsNeighborCell: boolean;
  /** How far past the cell boundary the chair would reach, in px; 0 when
   *  `overlapsNeighborCell` is false. */
  overlapAmountPx: number;
}

/**
 * Reports whether enlarging deskGrid's chairs via `chairVisualScale` would
 * visually reach into the next desk's cell — WITHOUT introducing real
 * collision detection and WITHOUT changing anything about how deskGrid
 * places furniture or seats. Purely diagnostic: it never clamps or modifies
 * the requested scale, it only tells the caller (a future admin UI, or a
 * developer picking a value) what the real risk is, so they can decide.
 *
 * Only checks the horizontal axis, matching deskGrid's own geometry: chairs
 * sit left/right of the desk (see chair()'s call sites in deskGrid), so
 * horizontal clearance is what a bigger chair actually threatens — the
 * vertical cell height has no equivalent squeeze (MIN_DESK_CELL_HEIGHT is
 * just DESK_SIZE, with no chair-driven term at all, per deskGridFits' own
 * docs above).
 */
export function deskGridChairOverlapRisk(
  rect: TileRect,
  opts: { cols: number; rows: number },
  requestedScale: number,
): ChairOverlapRisk {
  const box = tileRectToWorld(rect);
  const cellW = box.width / opts.cols;
  const chairGap = DESK_SIZE / 2 + CHAIR_SIZE / 2 + 6; // same formula deskGrid itself uses
  const availableSlackPx = cellW / 2 - chairGap - CHAIR_SIZE / 2;
  const renderedChairHalfSizePx = (CHAIR_SIZE * requestedScale * CHAIR_RENDER_FACTOR) / 2;
  const overlapAmountPx = Math.max(0, renderedChairHalfSizePx - CHAIR_SIZE / 2 - availableSlackPx);
  return {
    requestedScale,
    renderedChairHalfSizePx,
    availableSlackPx,
    overlapsNeighborCell: overlapAmountPx > 0,
    overlapAmountPx,
  };
}

export function deskGrid(
  idPrefix: string,
  rect: TileRect,
  opts: {
    cols: number;
    rows: number;
    startNumber: number;
    /** Optional, rendering-only — see FurniturePiece.visualScale's docs.
     *  Omitted (the default for every existing call site, including
     *  office300.ts) means every chair renders at its logical size exactly
     *  as before this option existed; `Seat.anchor`/`chairGap` below are
     *  computed identically whether or not this is set. Before enabling a
     *  scale above ~1 here, check deskGridChairOverlapRisk — deskGrid's
     *  cell has very little horizontal clearance today. */
    chairVisualScale?: number;
  },
): ModuleResult {
  const box = tileRectToWorld(rect);
  const cellW = box.width / opts.cols;
  const cellH = box.height / opts.rows;
  const result = empty();

  let num = opts.startNumber;
  for (let r = 0; r < opts.rows; r++) {
    for (let c = 0; c < opts.cols; c++) {
      const cx = box.x + cellW * (c + 0.5);
      const cy = box.y + cellH * (r + 0.5);
      const deskId = `${idPrefix}-desk-${num}`;
      result.furniture.push({
        id: deskId,
        kind: "desk",
        x: cx - DESK_SIZE / 2,
        y: cy - DESK_SIZE / 2,
        width: DESK_SIZE,
        height: DESK_SIZE,
        rotation: 0,
        label: `Desk ${num}`,
      });
      const chairGap = DESK_SIZE / 2 + CHAIR_SIZE / 2 + 6;
      result.furniture.push(chair(`${deskId}-chair-a`, cx - chairGap, cy, cx, cy, opts.chairVisualScale));
      result.furniture.push(chair(`${deskId}-chair-b`, cx + chairGap, cy, cx, cy, opts.chairVisualScale));
      result.seats.push({ id: `${deskId}-a`, label: `Desk ${num}`, anchor: { x: cx - chairGap, y: cy } });
      result.seats.push({ id: `${deskId}-b`, label: `Desk ${num}`, anchor: { x: cx + chairGap, y: cy } });
      num += 1;
    }
  }
  return result;
}

/** A square n×n pod of two-person desks — a thin convenience wrapper over
 *  deskGrid for layouts that want a compact cluster rather than a long grid. */
export function deskPod(idPrefix: string, rect: TileRect, n: 2 | 3 | 4 | 5, startNumber: number): ModuleResult {
  return deskGrid(idPrefix, rect, { cols: n, rows: n, startNumber });
}

/** Rotates a point around the origin by `angle` radians - the same
 *  convention as FurniturePiece.rotation (clockwise-positive, Pixi's
 *  convention), used to place every piece of an angled cluster as one
 *  rigid group without FurniturePiece supporting parent/child transforms. */
function rotateAroundOrigin(x: number, y: number, angle: number): Point {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return { x: x * cos - y * sin, y: x * sin + y * cos };
}

/**
 * An 8-seat angled desk pod: two facing rows of 4 single-seat desks around
 * a shared aisle, with a partition between neighbouring desks and one
 * monitor per desk - the exact shape approved on the artifact board
 * (https://claude.ai/artifact/81B5mLZKiPn3c3jQd3Vyw2), reused here as data
 * per rule 17 rather than redrawn from memory. `rotationRad` defaults to
 * the approved picture's own angle.
 *
 * The pod rotates as one rigid unit: every desk/monitor/partition is laid
 * out in a local, origin-centred frame first, then rotated by
 * `rotationRad` and placed at the rect's centre - the same technique the
 * artifact board's Pixi Container rotation used, done here in plain data
 * since FurniturePiece has no parent/child transform of its own. Each
 * chair's facing is computed by the existing `chair()` helper from the
 * two pieces' final, already-rotated world positions, so the proven
 * atan2 facing rule needs no separate rotation-composition logic.
 *
 * Requires the FloorView.ts fix that rotates every furniture kind around
 * its own centre, not just chairs (desks/monitors/partitions all carry a
 * non-zero rotation here) - at rotation 0 that fix is a no-op, so it does
 * not affect deskGrid/benchTable/any other existing block.
 */
export function angledDeskPod(idPrefix: string, rect: TileRect, startNumber: number, rotationRad = -0.2): ModuleResult {
  const box = tileRectToWorld(rect);
  const podCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

  const deskW = 66;
  const deskH = 60;
  const gapBetween = 10;
  // Each row's chair sits deskH/2 + CHAIR_SIZE/2 + 8 = 55px from its own row
  // centre, facing the aisle. The two rows' chairs face each other across
  // that aisle, so their centre-to-centre distance is rowGap - 2*55 =
  // rowGap - 110 - this must clear CHAIR_SIZE (34) with real margin, not
  // just avoid a negative number. 96 (the artifact board's own value, which
  // only looked fine because the mockup never checked real chair footprints)
  // gave a NEGATIVE gap of -14, i.e. the two rows' chairs overlapped by 14px
  // - caught by professional200.test.ts's whole-layout overlap check, not
  // by eye. 190 leaves 80px of real clearance between the two rows' chairs.
  const rowGap = 190;
  const cols = 4;
  const totalW = cols * deskW + (cols - 1) * gapBetween;

  const place = (localX: number, localY: number): Point => {
    const rotated = rotateAroundOrigin(localX, localY, rotationRad);
    return { x: podCenter.x + rotated.x, y: podCenter.y + rotated.y };
  };

  const result = empty();
  let num = startNumber;

  // chairSide: +1 = chair sits below the desk (facing down into the aisle),
  // -1 = chair sits above the desk (facing up into the aisle) - the two
  // rows face each other across the shared aisle between them.
  const rows: Array<{ rowY: number; chairSide: 1 | -1 }> = [
    { rowY: -rowGap / 2, chairSide: 1 },
    { rowY: rowGap / 2, chairSide: -1 },
  ];

  for (const { rowY, chairSide } of rows) {
    for (let i = 0; i < cols; i++) {
      const localDx = -totalW / 2 + i * (deskW + gapBetween) + deskW / 2;
      const deskId = `${idPrefix}-desk-${num}`;

      const deskCentre = place(localDx, rowY);
      result.furniture.push({
        id: deskId,
        kind: "desk",
        x: deskCentre.x - deskW / 2,
        y: deskCentre.y - deskH / 2,
        width: deskW,
        height: deskH,
        rotation: rotationRad,
        label: `Pod ${num}`,
      });

      if (i > 0) {
        const localPx = localDx - deskW / 2 - gapBetween / 2;
        const partHeight = deskH + 8;
        const partCentre = place(localPx, rowY);
        result.furniture.push({
          id: `${deskId}-partition`,
          kind: "wall",
          x: partCentre.x - 1.5,
          y: partCentre.y - partHeight / 2,
          width: 3,
          height: partHeight,
          rotation: rotationRad,
        });
      }

      const monCentre = place(localDx, rowY + chairSide * (deskH / 2 - 6));
      result.furniture.push({
        id: `${deskId}-monitor`,
        kind: "screen",
        x: monCentre.x - 16,
        y: monCentre.y - 4,
        width: 32,
        height: 8,
        rotation: rotationRad,
      });

      const chairPos = place(localDx, rowY + chairSide * (deskH / 2 + CHAIR_SIZE / 2 + 8));
      result.furniture.push(chair(`${deskId}-chair`, chairPos.x, chairPos.y, deskCentre.x, deskCentre.y));
      result.seats.push({ id: `${deskId}-seat`, label: `Pod ${num}`, anchor: chairPos });

      num += 1;
    }
  }

  return result;
}

/** A big SQUARE shared table seating exactly four, one chair per side —
 *  the "Bench 19 / Bench 20" unit from the approved design. Deliberately
 *  square, never a rectangle, to read as visually distinct from the
 *  two-person desks (per the user's explicit correction on the mockup). */
export function benchTable(idPrefix: string, rect: TileRect, label: string): ModuleResult {
  const box = tileRectToWorld(rect);
  const side = Math.min(box.width, box.height) * 0.55;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const zoneId = `${idPrefix}-zone`;
  const half = side / 2 + CHAIR_SIZE / 2 + 6;

  return {
    furniture: [
      { id: `${idPrefix}-table`, kind: "table", x: cx - side / 2, y: cy - side / 2, width: side, height: side, rotation: 0, label },
      chair(`${idPrefix}-chair-n`, cx, cy - half, cx, cy),
      chair(`${idPrefix}-chair-s`, cx, cy + half, cx, cy),
      chair(`${idPrefix}-chair-e`, cx + half, cy, cx, cy),
      chair(`${idPrefix}-chair-w`, cx - half, cy, cx, cy),
    ],
    seats: [
      { id: `${idPrefix}-n`, label, anchor: { x: cx, y: cy - half }, zoneId },
      { id: `${idPrefix}-s`, label, anchor: { x: cx, y: cy + half }, zoneId },
      { id: `${idPrefix}-e`, label, anchor: { x: cx + half, y: cy }, zoneId },
      { id: `${idPrefix}-w`, label, anchor: { x: cx - half, y: cy }, zoneId },
    ],
    zones: [{ id: zoneId, label, kind: "open", rect, capacity: 4 }],
  };
}

/** A long table with `capacity` chairs: one at each end plus the rest split
 *  evenly along the two long sides — the Meeting Room A arrangement (9 per
 *  side + 1 at each end for capacity 20). */
export function meetingRoom(idPrefix: string, rect: TileRect, opts: { label: string; capacity: number }): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const tableW = box.width * 0.6;
  const tableH = box.height * 0.35;
  const tx = box.x + (box.width - tableW) / 2;
  const ty = box.y + (box.height - tableH) / 2;
  const cy = ty + tableH / 2;
  const cx = tx + tableW / 2;

  const perSide = Math.max(0, Math.floor((opts.capacity - 2) / 2));
  const result = empty();
  result.furniture.push({ id: `${idPrefix}-table`, kind: "table", x: tx, y: ty, width: tableW, height: tableH, rotation: 0, label: opts.label });
  result.furniture.push({ id: `${idPrefix}-screen`, kind: "screen", x: tx + tableW / 2 - 40, y: box.y + 8, width: 80, height: 10, rotation: 0 });

  let seatNum = 1;
  const addSeat = (x: number, y: number) => {
    const seatId = `${idPrefix}-${seatNum}`;
    result.furniture.push(chair(`${seatId}-chair`, x, y, cx, cy));
    result.seats.push({ id: seatId, label: opts.label, anchor: { x, y }, zoneId });
    seatNum += 1;
  };

  // A corner-side chair here faces the table's CENTRE (via chair()), not
  // straight out from its own edge - so near the table's ends its facing is
  // meaningfully diagonal, and a diagonally-rotated square chair reaches out
  // to its own half-DIAGONAL (CHAIR_SIZE/2 * sqrt(2) ≈ 24) in that direction,
  // not just its half-width (17). The original `CHAIR_SIZE/2 + 6` clearance
  // only budgeted for the half-width case, so end-of-row seats could clip
  // the table by a few px - caught by professional200.test.ts's whole-layout
  // overlap check, not visible by eye at normal zoom. Every seat gets the
  // same worst-case clearance rather than computing each one's actual angle,
  // since the extra few px costs nothing and keeps this one formula correct
  // for any capacity/table size, including openOffice1's own real usage.
  const chairClearance = (CHAIR_SIZE / 2) * Math.SQRT2 + 6;

  for (let i = 0; i < perSide; i++) {
    const x = tx + (tableW / (perSide + 1)) * (i + 1);
    addSeat(x, ty - chairClearance);
    addSeat(x, ty + tableH + chairClearance);
  }
  addSeat(tx - chairClearance, cy);
  addSeat(tx + tableW + chairClearance, cy);

  result.zones.push({ id: zoneId, label: opts.label, kind: "meeting", rect, capacity: opts.capacity });
  return result;
}

/** Two parallel long tables, each with `capacity/2` chairs split top/bottom
 *  and no end chairs — the Standup Area arrangement (two tables of 10). */
export function standupArea(idPrefix: string, rect: TileRect, opts: { capacity: number }): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const label = "Standup Area";
  const perTable = Math.ceil(opts.capacity / 2);
  const perSide = Math.max(1, Math.floor(perTable / 2));

  const result = empty();
  result.furniture.push({
    id: `${idPrefix}-whiteboard`,
    kind: "whiteboard",
    x: box.x + 8,
    y: box.y + box.height * 0.15,
    width: 8,
    height: box.height * 0.7,
    rotation: 0,
  });

  let seatNum = 1;
  const tableRows = [0.35, 0.7];
  for (const rowFrac of tableRows) {
    const tableW = box.width * 0.7;
    const tx = box.x + box.width * 0.2;
    const ty = box.y + box.height * rowFrac - 12;
    result.furniture.push({ id: `${idPrefix}-table-${rowFrac}`, kind: "table", x: tx, y: ty, width: tableW, height: 24, rotation: 0, label });

    for (let i = 0; i < perSide; i++) {
      const x = tx + (tableW / (perSide + 1)) * (i + 1);
      for (const dy of [-CHAIR_SIZE / 2 - 6, 24 + CHAIR_SIZE / 2 + 6]) {
        const y = ty + dy;
        const seatId = `${idPrefix}-${seatNum}`;
        result.furniture.push(chair(`${seatId}-chair`, x, y, x, ty + 12));
        result.seats.push({ id: seatId, label, anchor: { x, y }, zoneId });
        seatNum += 1;
      }
    }
  }

  result.zones.push({ id: zoneId, label, kind: "open", rect, capacity: perSide * 2 * tableRows.length });
  return result;
}

/** A stage (no seats — the presenter stands) plus an audience grid of
 *  `rows` x `cols` chairs, the audience zone pointed at the stage via
 *  `stageId` for the directed zone-audio broadcast rule. */
/** The stage/screen/plants block shared by every stage-facing seating layout
 *  (allHands' individual chairs, benchRows' continuous benches) - pulled out
 *  once both needed the identical stage so it's never duplicated per rule 21
 *  (new templates reuse shared formulas, not their own copy of the math). */
function stageAndScreen(idPrefix: string, rect: TileRect) {
  const box = tileRectToWorld(rect);
  const stageId = `${idPrefix}-stage`;

  const stageRect: TileRect = { col: rect.col, row: rect.row, cols: rect.cols, rows: Math.max(1, Math.round(rect.rows * 0.25)) };
  const stageBox = tileRectToWorld(stageRect);
  const audienceTop = stageBox.y + stageBox.height;
  const audienceHeight = box.y + box.height - audienceTop;

  const furniture: FurniturePiece[] = [
    { id: `${idPrefix}-stage-riser`, kind: "stage", x: stageBox.x + stageBox.width * 0.15, y: stageBox.y + 8, width: stageBox.width * 0.7, height: stageBox.height * 0.55, rotation: 0 },
    { id: `${idPrefix}-screen`, kind: "screen", x: stageBox.x + stageBox.width * 0.3, y: stageBox.y + 4, width: stageBox.width * 0.4, height: 8, rotation: 0 },
    // Margin must clear PLANT_SIZE/2 (14) or the plant's own edge goes
    // negative whenever this stage's rect starts at the floor's column 0 -
    // openOffice1's allHands never does (col 4), which is why this stayed
    // latent until professional200's auditorium (col 0) hit it directly via
    // validateLayout's real floor-bounds check, not a visual inspection.
    plant(`${idPrefix}-plant-l`, stageBox.x + 16, stageBox.y + stageBox.height / 2),
    plant(`${idPrefix}-plant-r`, stageBox.x + stageBox.width - 16, stageBox.y + stageBox.height / 2),
  ];

  return { box, stageId, stageRect, audienceTop, audienceHeight, furniture };
}

export function allHands(idPrefix: string, rect: TileRect, opts: { rows: number; cols: number }): ModuleResult {
  const audienceId = `${idPrefix}-audience`;
  const label = "All Hands";
  const { box, stageId, stageRect, audienceTop, audienceHeight, furniture } = stageAndScreen(idPrefix, rect);

  const result = empty();
  result.furniture.push(...furniture);

  const cellW = box.width / opts.cols;
  const cellH = audienceHeight / opts.rows;
  for (let r = 0; r < opts.rows; r++) {
    for (let c = 0; c < opts.cols; c++) {
      const x = box.x + cellW * (c + 0.5);
      const y = audienceTop + cellH * (r + 0.5);
      const seatId = `${idPrefix}-${r * opts.cols + c + 1}`;
      result.furniture.push(chair(`${seatId}-chair`, x, y, x, audienceTop));
      result.seats.push({ id: seatId, label, anchor: { x, y }, zoneId: audienceId });
    }
  }

  result.zones.push({ id: stageId, label, kind: "stage", rect: stageRect });
  result.zones.push({
    id: audienceId,
    label,
    kind: "audience",
    rect: { col: rect.col, row: stageRect.row + stageRect.rows, cols: rect.cols, rows: rect.rows - stageRect.rows },
    capacity: opts.rows * opts.cols,
    stageId,
  });
  return result;
}

/**
 * The auditorium approved on the artifact board
 * (https://claude.ai/artifact/HrPzNCi3HeYQtZyAG5muo1): the same stage,
 * screen and plants as `allHands`, but continuous bench rows instead of
 * individual chairs - one `table`-kind furniture piece per row (a bench,
 * per rule 8, reuses an existing shape rather than a new one), with
 * `seatsPerRow` seats spaced evenly along it. Each seat's anchor sits ON
 * the bench (no separate chair furniture, matching the approved picture),
 * and still gets its own thin divider ("wall" kind, matching the
 * partitions already used in angledDeskPod) at every seat boundary.
 *
 * No chair FurniturePiece exists per seat here - a seat needing its own
 * chair object is a deskGrid/allHands convention, not a rule; the only
 * hard requirement (rule per the seat-claim work) is a real Seat with a
 * real anchor, which every seat below has.
 */
export function benchRows(idPrefix: string, rect: TileRect, opts: { rows: number; seatsPerRow: number }): ModuleResult {
  const audienceId = `${idPrefix}-audience`;
  const label = "Auditorium";
  const { box, stageId, stageRect, audienceTop, audienceHeight, furniture } = stageAndScreen(idPrefix, rect);

  const result = empty();
  result.furniture.push(...furniture);

  const rowGap = audienceHeight / opts.rows;
  const benchHeight = 16;
  const benchMarginX = box.width * 0.03;
  const benchWidth = box.width - benchMarginX * 2;

  for (let r = 0; r < opts.rows; r++) {
    const rowY = audienceTop + rowGap * (r + 0.5);
    const benchId = `${idPrefix}-bench-${r + 1}`;
    result.furniture.push({
      id: benchId,
      kind: "table",
      x: box.x + benchMarginX,
      y: rowY - benchHeight / 2,
      width: benchWidth,
      height: benchHeight,
      rotation: 0,
      label: `Row ${r + 1}`,
    });

    for (let s = 0; s < opts.seatsPerRow; s++) {
      const x = box.x + benchMarginX + (benchWidth / opts.seatsPerRow) * (s + 0.5);
      const seatId = `${idPrefix}-${r * opts.seatsPerRow + s + 1}`;
      result.seats.push({ id: seatId, label, anchor: { x, y: rowY }, zoneId: audienceId });

      if (s > 0) {
        const dividerX = box.x + benchMarginX + (benchWidth / opts.seatsPerRow) * s;
        result.furniture.push({
          id: `${seatId}-divider`,
          kind: "wall",
          x: dividerX - 1,
          y: rowY - benchHeight / 2 - 3,
          width: 2,
          height: benchHeight + 6,
          rotation: 0,
        });
      }
    }
  }

  result.zones.push({ id: stageId, label, kind: "stage", rect: stageRect });
  result.zones.push({
    id: audienceId,
    label,
    kind: "audience",
    rect: { col: rect.col, row: stageRect.row + stageRect.rows, cols: rect.cols, rows: rect.rows - stageRect.rows },
    capacity: opts.rows * opts.seatsPerRow,
    stageId,
  });
  return result;
}

/** A private, square desk for two plus a plant — capacity is always 2. */
export function privateCabin(idPrefix: string, rect: TileRect, opts: { label: string }): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const half = DESK_SIZE / 2 + CHAIR_SIZE / 2 + 6;

  return {
    furniture: [
      { id: `${idPrefix}-desk`, kind: "desk", x: cx - DESK_SIZE / 2, y: cy - DESK_SIZE / 2, width: DESK_SIZE, height: DESK_SIZE, rotation: 0, label: opts.label },
      chair(`${idPrefix}-chair-a`, cx - half, cy, cx, cy),
      chair(`${idPrefix}-chair-b`, cx + half, cy, cx, cy),
      plant(`${idPrefix}-plant`, box.x + box.width - 16, box.y + 16),
    ],
    seats: [
      { id: `${idPrefix}-a`, label: opts.label, anchor: { x: cx - half, y: cy }, zoneId },
      { id: `${idPrefix}-b`, label: opts.label, anchor: { x: cx + half, y: cy }, zoneId },
    ],
    zones: [{ id: zoneId, label: opts.label, kind: "cabin", rect, capacity: 2 }],
  };
}

/** `tableCount` tables, each with `chairsPerTable` chairs around it,
 *  staggered vertically within the rect (never stacked in a straight line)
 *  — the collaboration-table arrangement. */
export function collabTables(
  idPrefix: string,
  rect: TileRect,
  opts: { tableCount: number; chairsPerTable: number; /** Line the tables up in one column instead of staggering them. */ aligned?: boolean },
): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const label = "Collaboration";
  const rowH = box.height / opts.tableCount;
  const tableW = box.width * 0.55;
  const tableH = Math.min(rowH * 0.4, 60);

  const result = empty();
  let seatNum = 1;
  for (let t = 0; t < opts.tableCount; t++) {
    const stagger = opts.aligned ? (1 - 0.55) / 2 : t % 2 === 0 ? 0.2 : 0.4;
    const tx = box.x + box.width * stagger;
    const ty = box.y + rowH * (t + 0.5) - tableH / 2;
    const cx = tx + tableW / 2;
    const cy = ty + tableH / 2;
    result.furniture.push({ id: `${idPrefix}-table-${t}`, kind: "table", x: tx, y: ty, width: tableW, height: tableH, rotation: 0, label });

    const perSide = Math.floor((opts.chairsPerTable - 2) / 2);
    const addSeat = (x: number, y: number) => {
      const seatId = `${idPrefix}-${seatNum}`;
      result.furniture.push(chair(`${seatId}-chair`, x, y, cx, cy));
      result.seats.push({ id: seatId, label, anchor: { x, y }, zoneId });
      seatNum += 1;
    };
    for (let i = 0; i < perSide; i++) {
      const x = tx + (tableW / (perSide + 1)) * (i + 1);
      addSeat(x, ty - CHAIR_SIZE / 2 - 6);
      addSeat(x, ty + tableH + CHAIR_SIZE / 2 + 6);
    }
    addSeat(tx - CHAIR_SIZE / 2 - 6, cy);
    addSeat(tx + tableW + CHAIR_SIZE / 2 + 6, cy);
  }

  result.zones.push({ id: zoneId, label, kind: "open", rect, capacity: opts.tableCount * opts.chairsPerTable });
  return result;
}

/** A counter with `stoolCount` stools along it. */
export function kitchen(idPrefix: string, rect: TileRect, opts: { stoolCount: number }): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const label = "Kitchen";
  const counterY = box.y + box.height * 0.3;
  const counterW = box.width * 0.8;
  const counterX = box.x + (box.width - counterW) / 2;

  const result = empty();
  result.furniture.push({ id: `${idPrefix}-counter`, kind: "counter", x: counterX, y: counterY, width: counterW, height: 20, rotation: 0, label });

  for (let i = 0; i < opts.stoolCount; i++) {
    const x = counterX + (counterW / (opts.stoolCount + 1)) * (i + 1);
    const y = counterY + 20 + CHAIR_SIZE / 2 + 6;
    const seatId = `${idPrefix}-${i + 1}`;
    result.furniture.push(chair(`${seatId}-chair`, x, y, x, counterY));
    result.seats.push({ id: seatId, label, anchor: { x, y }, zoneId });
  }

  result.zones.push({ id: zoneId, label, kind: "open", rect, capacity: opts.stoolCount });
  return result;
}

/** Sofas + plants along the edges of the rect, with `seatCount` seats. */
export function lounge(idPrefix: string, rect: TileRect, opts: { seatCount: number }): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const label = "Lounge";

  const result = empty();
  const sofaCount = Math.ceil(opts.seatCount / 3);
  const seatsPerSofa = Math.ceil(opts.seatCount / sofaCount);
  let placed = 0;

  for (let s = 0; s < sofaCount && placed < opts.seatCount; s++) {
    const sofaW = Math.min(box.width * 0.6, seatsPerSofa * 40);
    const sofaX = box.x + box.width * 0.15;
    const sofaY = box.y + (box.height / sofaCount) * (s + 0.5) - 15;
    result.furniture.push({ id: `${idPrefix}-sofa-${s}`, kind: "sofa", x: sofaX, y: sofaY, width: sofaW, height: 30, rotation: 0, label });

    for (let i = 0; i < seatsPerSofa && placed < opts.seatCount; i++) {
      const x = sofaX + (sofaW / (seatsPerSofa + 1)) * (i + 1);
      const y = sofaY + 15;
      const seatId = `${idPrefix}-${placed + 1}`;
      result.seats.push({ id: seatId, label, anchor: { x, y }, zoneId });
      placed += 1;
    }
  }
  result.furniture.push(plant(`${idPrefix}-plant`, box.x + box.width - 16, box.y + box.height - 16));

  result.zones.push({ id: zoneId, label, kind: "open", rect, capacity: opts.seatCount });
  return result;
}

/**
 * A standing, single-occupant phone booth (no seat — matches the approved
 * artifact: https://claude.ai/artifact/5sLiD5PqJr4fUQc5H1VxKW). No existing
 * block matches this (checked `privateCabin` — that's seated, capacity 2),
 * so this is a genuinely new arrangement per rule 6, but built entirely
 * from existing FurnitureKinds: `wall` for three sides, `counter` for the
 * small shelf, `door` for the open fourth side — no new kind, no renderer
 * change. Zone kind `focus` already exists for exactly this ("a place to
 * be alone"), reused rather than inventing a new one.
 */
export function phoneBooth(idPrefix: string, rect: TileRect): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const bw = box.width * 0.5;
  const bh = box.height * 0.6;
  const bx = box.x + (box.width - bw) / 2;
  const by = box.y + (box.height - bh) / 2;
  const wallT = 6;

  return {
    furniture: [
      { id: `${idPrefix}-wall-back`, kind: "wall", x: bx, y: by, width: bw, height: wallT, rotation: 0 },
      { id: `${idPrefix}-wall-left`, kind: "wall", x: bx, y: by, width: wallT, height: bh, rotation: 0 },
      { id: `${idPrefix}-wall-right`, kind: "wall", x: bx + bw - wallT, y: by, width: wallT, height: bh, rotation: 0 },
      { id: `${idPrefix}-shelf`, kind: "counter", x: bx + 8, y: by + bh * 0.55, width: bw - 16, height: 14, rotation: 0 },
      { id: `${idPrefix}-door`, kind: "door", x: bx, y: by + bh - 2, width: bw, height: 2, rotation: 0 },
    ],
    seats: [],
    zones: [{ id: zoneId, label: "Phone Booth", kind: "focus", rect, capacity: 1 }],
  };
}

/**
 * A round table with `seatCount` chairs spaced evenly around it — the one
 * shared generator behind BOTH the private-cabin round table and reception
 * round tables from the reference images, since both are the same real
 * shape at different sizes/capacities (rule 21: shared math, not two
 * near-identical one-offs). A circle needs no new rendering: FloorView's
 * existing "table" case draws `roundRect(x,y,width,height,min(40,height/2))`
 * — a square piece (width === height) with radius === height/2 already
 * renders as a true circle. Each chair faces the table's own centre via
 * the same proven `chair()` helper as every other block.
 */
export function roundTable(
  idPrefix: string,
  rect: TileRect,
  opts: { label: string; seatCount: number; zoneKind?: "meeting" | "open" },
): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const diameter = Math.min(box.width, box.height) * 0.5;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // The table piece is stored as an actual square (rendered as a circle only
  // via FloorView's corner rounding) - the real overlap check (collision.ts)
  // sees its true square corners, which reach further than the visual circle
  // (half-diagonal, not half-width). Seats must clear THAT reach, not the
  // visual radius, or a chair near a corner would overlap the square's hitbox.
  const tableHalfDiagonal = (diameter / 2) * Math.SQRT2;
  const seatRadius = tableHalfDiagonal + CHAIR_SIZE / 2 + 6;

  const result = empty();
  result.furniture.push({
    id: `${idPrefix}-table`,
    kind: "table",
    x: cx - diameter / 2,
    y: cy - diameter / 2,
    width: diameter,
    height: diameter,
    rotation: 0,
    label: opts.label,
  });

  for (let i = 0; i < opts.seatCount; i++) {
    const angle = (i / opts.seatCount) * Math.PI * 2;
    const x = cx + Math.cos(angle) * seatRadius;
    const y = cy + Math.sin(angle) * seatRadius;
    const seatId = `${idPrefix}-${i + 1}`;
    result.furniture.push(chair(`${seatId}-chair`, x, y, cx, cy));
    result.seats.push({ id: seatId, label: opts.label, anchor: { x, y }, zoneId });
  }

  result.zones.push({ id: zoneId, label: opts.label, kind: opts.zoneKind ?? "meeting", rect, capacity: opts.seatCount });
  return result;
}

/**
 * The round/pit lounge variant from the reference images: sofa segments
 * arranged in a ring around a shared centre, each facing inward, instead
 * of `lounge`'s straight sofas along an edge. Reuses `rotateAroundOrigin`
 * (already proven placing angledDeskPod's rotated pieces) rather than a
 * second rotation formula, per rule 21. No chair furniture per seat —
 * same convention as `benchRows`: a real Seat with a real anchor is the
 * only hard requirement, not a chair object.
 */
export function roundLounge(idPrefix: string, rect: TileRect, opts: { segments: number; seatsPerSegment: number }): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const label = "Lounge";
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const ringRadius = Math.min(box.width, box.height) * 0.32;
  const segmentW = opts.seatsPerSegment * 40;
  const segmentH = 30;
  const seatInset = segmentH / 2 + 8; // offset from the sofa's centre toward the ring's centre

  const result = empty();
  let seatNum = 1;
  for (let i = 0; i < opts.segments; i++) {
    const angle = (i / opts.segments) * Math.PI * 2;
    const segCx = cx + Math.cos(angle) * ringRadius;
    const segCy = cy + Math.sin(angle) * ringRadius;
    const rotation = angle + Math.PI / 2; // tangent to the ring at rest

    result.furniture.push({
      id: `${idPrefix}-sofa-${i}`,
      kind: "sofa",
      x: segCx - segmentW / 2,
      y: segCy - segmentH / 2,
      width: segmentW,
      height: segmentH,
      rotation,
      label,
    });

    for (let s = 0; s < opts.seatsPerSegment; s++) {
      const localX = -segmentW / 2 + (segmentW / (opts.seatsPerSegment + 1)) * (s + 1);
      const offset = rotateAroundOrigin(localX, seatInset, rotation);
      const x = segCx + offset.x;
      const y = segCy + offset.y;
      const seatId = `${idPrefix}-${seatNum}`;
      result.seats.push({ id: seatId, label, anchor: { x, y }, zoneId });
      seatNum += 1;
    }
  }

  result.zones.push({ id: zoneId, label, kind: "open", rect, capacity: opts.segments * opts.seatsPerSegment });
  return result;
}

/**
 * Banks of shared desks for 2 or 3 people (the owner's "2-desk people / 3-desk people" option, 2026-09-23): each
 * cell is two desks back to back, every person with their own chair facing their own place at the desk. Seats follow
 * the same rule as every other module: one seat anchored exactly on each chair. The bank is one open area, so it
 * counts its own people and lights up on hover.
 */
export function deskBank(
  idPrefix: string,
  rect: TileRect,
  opts: { seatsPerDesk: 2 | 3; cols: number; rows: number; startNumber: number; label: string },
): ModuleResult {
  const box = tileRectToWorld(rect);
  const cellW = box.width / opts.cols;
  const cellH = box.height / opts.rows;
  const zoneId = `${idPrefix}-zone`;
  const pitch = 60; // one person's width along the desk
  const deskW = pitch * opts.seatsPerDesk;
  const deskD = 44;
  const chairGap = deskD + CHAIR_SIZE / 2 + 4; // chair centre from the desks' shared back edge
  const result = empty();

  let num = opts.startNumber;
  for (let r = 0; r < opts.rows; r++) {
    for (let c = 0; c < opts.cols; c++) {
      const cx = box.x + cellW * (c + 0.5);
      const cy = box.y + cellH * (r + 0.5);
      for (const side of [-1, 1] as const) {
        const deskId = `${idPrefix}-desk-${num}`;
        const label = `Desk ${num}`;
        result.furniture.push({ id: deskId, kind: "desk", x: cx - deskW / 2, y: side < 0 ? cy - deskD : cy, width: deskW, height: deskD, rotation: 0, label });
        for (let i = 0; i < opts.seatsPerDesk; i++) {
          const x = cx - deskW / 2 + pitch * (i + 0.5);
          const y = cy + side * chairGap;
          const letter = String.fromCharCode(97 + i);
          // each person faces their own place on the desk (straight across it)
          result.furniture.push(chair(`${deskId}-chair-${letter}`, x, y, x, cy + (side * deskD) / 2));
          result.seats.push({ id: `${deskId}-${letter}`, label, anchor: { x, y }, zoneId });
        }
        num += 1;
      }
    }
  }
  result.zones.push({ id: zoneId, label: opts.label, kind: "open", rect, capacity: result.seats.length });
  return result;
}

/** The on-screen chair size drawChair produces for a given visualScale. */
export function renderedChairSizePx(visualScale = 1): number {
  return CHAIR_SIZE * CHAIR_RENDER_FACTOR * visualScale;
}

export interface TableGroupSpec {
  /** Unique, stable table-group id. Also the table furniture piece's id, and every seat's `tableId`. */
  tableId: string;
  label: string;
  center: Point;
  /** The table's size, in world px (its logical and drawn size are the same: tables are never visually scaled). */
  width: number;
  depth: number;
  /** How many chairs sit along each side. Their sum is the table's capacity; nothing assumes any particular number. */
  seats: { top: number; bottom: number; left: number; right: number };
  chairVisualScale: number;
  /** Gap, in world px, between a chair's DRAWN edge and the table edge. */
  chairClearancePx: number;
}

/**
 * One table with its chairs and seats, with explicit membership: the table piece's id is the table-group id, every
 * seat carries it as `tableId`, and every chair carries its seat's id as `seatId` — nothing depends on parsing ids.
 * Chairs are spread evenly along each side and placed from the DRAWN chair size, so a larger `chairVisualScale` moves
 * the chair (and its seat, which is always exactly the chair's centre) out far enough to clear the table instead of
 * drawing into it. Each chair faces straight across its own side, like deskBank's.
 */
export function tableGroup(spec: TableGroupSpec): ModuleResult {
  const { tableId, label, center, width, depth } = spec;
  const offset = renderedChairSizePx(spec.chairVisualScale) / 2 + spec.chairClearancePx;
  const result = empty();
  result.furniture.push({ id: tableId, kind: "table", x: center.x - width / 2, y: center.y - depth / 2, width, height: depth, rotation: 0, label });

  let n = 1;
  const add = (x: number, y: number, faceX: number, faceY: number) => {
    const seatId = `${tableId}-s${n}`;
    result.furniture.push({ ...chair(`${seatId}-chair`, x, y, faceX, faceY, spec.chairVisualScale), seatId });
    result.seats.push({ id: seatId, label, anchor: { x, y }, tableId });
    n += 1;
  };
  const spread = (count: number, length: number, i: number) => -length / 2 + (length * (i + 1)) / (count + 1);

  for (let i = 0; i < spec.seats.top; i++) {
    const x = center.x + spread(spec.seats.top, width, i);
    add(x, center.y - depth / 2 - offset, x, center.y);
  }
  for (let i = 0; i < spec.seats.bottom; i++) {
    const x = center.x + spread(spec.seats.bottom, width, i);
    add(x, center.y + depth / 2 + offset, x, center.y);
  }
  for (let i = 0; i < spec.seats.left; i++) {
    const y = center.y + spread(spec.seats.left, depth, i);
    add(center.x - width / 2 - offset, y, center.x, y);
  }
  for (let i = 0; i < spec.seats.right; i++) {
    const y = center.y + spread(spec.seats.right, depth, i);
    add(center.x + width / 2 + offset, y, center.x, y);
  }
  return result;
}

export { merge as mergeModules };
