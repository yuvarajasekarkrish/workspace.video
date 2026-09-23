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
 *  none left after this change) would simply keep facing right (rotation 0). */
function chair(id: string, x: number, y: number, faceX: number, faceY: number): FurniturePiece {
  const rotation = Math.atan2(faceY - y, faceX - x);
  return { id, kind: "chair", x: x - CHAIR_SIZE / 2, y: y - CHAIR_SIZE / 2, width: CHAIR_SIZE, height: CHAIR_SIZE, rotation };
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
export function deskGrid(
  idPrefix: string,
  rect: TileRect,
  opts: { cols: number; rows: number; startNumber: number },
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
      result.furniture.push(chair(`${deskId}-chair-a`, cx - chairGap, cy, cx, cy));
      result.furniture.push(chair(`${deskId}-chair-b`, cx + chairGap, cy, cx, cy));
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

  for (let i = 0; i < perSide; i++) {
    const x = tx + (tableW / (perSide + 1)) * (i + 1);
    addSeat(x, ty - CHAIR_SIZE / 2 - 6);
    addSeat(x, ty + tableH + CHAIR_SIZE / 2 + 6);
  }
  addSeat(tx - CHAIR_SIZE / 2 - 6, cy);
  addSeat(tx + tableW + CHAIR_SIZE / 2 + 6, cy);

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
export function allHands(idPrefix: string, rect: TileRect, opts: { rows: number; cols: number }): ModuleResult {
  const box = tileRectToWorld(rect);
  const stageId = `${idPrefix}-stage`;
  const audienceId = `${idPrefix}-audience`;
  const label = "All Hands";

  const stageRect: TileRect = { col: rect.col, row: rect.row, cols: rect.cols, rows: Math.max(1, Math.round(rect.rows * 0.25)) };
  const stageBox = tileRectToWorld(stageRect);
  const audienceTop = stageBox.y + stageBox.height;
  const audienceHeight = box.y + box.height - audienceTop;

  const result = empty();
  result.furniture.push({ id: `${idPrefix}-stage-riser`, kind: "stage", x: stageBox.x + stageBox.width * 0.15, y: stageBox.y + 8, width: stageBox.width * 0.7, height: stageBox.height * 0.55, rotation: 0 });
  result.furniture.push({ id: `${idPrefix}-screen`, kind: "screen", x: stageBox.x + stageBox.width * 0.3, y: stageBox.y + 4, width: stageBox.width * 0.4, height: 8, rotation: 0 });
  result.furniture.push(plant(`${idPrefix}-plant-l`, stageBox.x + 12, stageBox.y + stageBox.height / 2));
  result.furniture.push(plant(`${idPrefix}-plant-r`, stageBox.x + stageBox.width - 12, stageBox.y + stageBox.height / 2));

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
export function collabTables(idPrefix: string, rect: TileRect, opts: { tableCount: number; chairsPerTable: number }): ModuleResult {
  const box = tileRectToWorld(rect);
  const zoneId = `${idPrefix}-zone`;
  const label = "Collaboration";
  const rowH = box.height / opts.tableCount;
  const tableW = box.width * 0.55;
  const tableH = Math.min(rowH * 0.4, 60);

  const result = empty();
  let seatNum = 1;
  for (let t = 0; t < opts.tableCount; t++) {
    const stagger = t % 2 === 0 ? 0.2 : 0.4;
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

export { merge as mergeModules };
