import { describe, it, expect } from "vitest";
import { cosmicCampus100, COSMIC_CAMPUS_100_ID, CHAIR_VISUAL_SCALE, COSMIC_TABLE_TYPES, NEXUS_CENTER } from "../cosmicCampus100";
import { office300 } from "../office300";
import { resolveLayout, listLayoutIds, DEFAULT_LAYOUT_ID, LAYOUT_LABELS } from "../registry";
import { validateLayout } from "../validate";
import { checkSeatingGeometry, drawnFootprint } from "../seatingGeometry";
import { seatsAtSameTable, zoneAt, parseRoomConfig } from "../queries";
import { renderedChairSizePx } from "../modules";
import { TILE_PX } from "../grid";

const layout = cosmicCampus100;
const tables = layout.furniture.filter((f) => f.kind === "table");
const chairs = layout.furniture.filter((f) => f.kind === "chair");
const seatsOf = (tableId: string) => layout.seats.filter((s) => s.tableId === tableId);

describe("Cosmic Campus — 100: capacity and table mix", () => {
  it("has exactly 24 tables, 100 chairs and 100 unique seats", () => {
    expect(tables).toHaveLength(24);
    expect(chairs).toHaveLength(100);
    expect(layout.seats).toHaveLength(100);
    expect(new Set(layout.seats.map((s) => s.id)).size).toBe(100);
  });

  it("has exactly 8 two-seat, 8 four-seat, 6 six-seat and 2 eight-seat tables, counted from the generated seats", () => {
    const bySize = new Map<number, number>();
    for (const t of tables) {
      const n = seatsOf(t.id).length;
      bySize.set(n, (bySize.get(n) ?? 0) + 1);
    }
    expect(Object.fromEntries(bySize)).toEqual({ 2: 8, 4: 8, 6: 6, 8: 2 });
  });

  it("gives each table size its own dimensions, larger for more seats", () => {
    const areaFor = (seats: number) => {
      const sizes = tables.filter((t) => seatsOf(t.id).length === seats).map((t) => t.width * t.height);
      expect(new Set(sizes).size).toBe(1);
      return sizes[0]!;
    };
    expect(areaFor(2)).toBeLessThan(areaFor(4));
    expect(areaFor(4)).toBeLessThan(areaFor(6));
    expect(areaFor(6)).toBeLessThan(areaFor(8));
  });
});

describe("Cosmic Campus — 100: explicit table-group and seat mapping", () => {
  it("every seat names exactly one existing table, and every table group has its configured seat count", () => {
    const tableIds = new Set(tables.map((t) => t.id));
    expect(tableIds.size).toBe(24);
    for (const s of layout.seats) expect(tableIds.has(s.tableId!)).toBe(true);
    const configured = Object.values(COSMIC_TABLE_TYPES).map((t) => t.seats.top + t.seats.bottom + t.seats.left + t.seats.right);
    for (const t of tables) expect(configured).toContain(seatsOf(t.id).length);
    expect(tables.reduce((sum, t) => sum + seatsOf(t.id).length, 0)).toBe(100);
  });

  it("every chair names exactly one seat, every seat has exactly one chair, and the seat anchor is the chair's centre", () => {
    const seatIds = new Set(layout.seats.map((s) => s.id));
    const chairSeatIds = chairs.map((c) => c.seatId);
    expect(chairSeatIds.every((id) => id !== undefined && seatIds.has(id))).toBe(true);
    expect(new Set(chairSeatIds).size).toBe(100);
    for (const s of layout.seats) {
      const chair = chairs.find((c) => c.seatId === s.id)!;
      expect(chair.x + chair.width / 2).toBe(s.anchor.x);
      expect(chair.y + chair.height / 2).toBe(s.anchor.y);
    }
  });

  it("seatsAtSameTable follows the explicit tableId for every table", () => {
    for (const t of tables) {
      const expected = seatsOf(t.id).map((s) => s.id).sort();
      for (const id of expected) expect(seatsAtSameTable(layout, id).map((s) => s.id).sort()).toEqual(expected);
    }
  });
});

describe("Cosmic Campus — 100: chairs", () => {
  it("draws every chair at CHAIR_VISUAL_SCALE, visibly larger than office300's, without changing its logical size", () => {
    expect(CHAIR_VISUAL_SCALE).toBeGreaterThan(1);
    for (const c of chairs) {
      expect(c.visualScale).toBe(CHAIR_VISUAL_SCALE);
      expect(c.width).toBe(34);
      expect(c.height).toBe(34);
    }
    const office300Chair = office300.furniture.find((f) => f.kind === "chair")!;
    expect(office300Chair.visualScale).toBeUndefined();
    expect(drawnFootprint(chairs[0]!).width).toBeGreaterThan(drawnFootprint(office300Chair).width);
    expect(renderedChairSizePx(CHAIR_VISUAL_SCALE)).toBeCloseTo(34 * 0.92 * 1.4, 9);
  });

  it("places each chair beside its own table (nearest table is its own)", () => {
    for (const c of chairs) {
      const own = layout.seats.find((s) => s.id === c.seatId)!.tableId;
      const cx = c.x + c.width / 2;
      const cy = c.y + c.height / 2;
      const dist = (t: (typeof tables)[number]) =>
        Math.hypot(Math.max(0, t.x - cx, cx - (t.x + t.width)), Math.max(0, t.y - cy, cy - (t.y + t.height)));
      const nearest = [...tables].sort((a, b) => dist(a) - dist(b))[0]!;
      expect(nearest.id).toBe(own);
    }
  });
});

describe("Cosmic Campus — 100: geometry", () => {
  it("passes the structural checks every layout passes", () => {
    const result = validateLayout(layout);
    if (!result.valid) expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("has no drawn overlap, keeps chairs clear of tables, keeps 80px walkways between groups, and stays on the floor", () => {
    expect(checkSeatingGeometry(layout, { minWalkwayPx: 80, minChairTableGapPx: 6 })).toEqual([]);
  });

  it("the checker really does catch problems: a bigger chair scale on the same tables overlaps", () => {
    const squeezed = {
      ...layout,
      furniture: layout.furniture.map((f) => (f.kind === "chair" ? { ...f, visualScale: 3 } : f)),
    };
    expect(checkSeatingGeometry(squeezed, { minWalkwayPx: 80, minChairTableGapPx: 6 }).length).toBeGreaterThan(0);
  });

  it("keeps the Nexus clear of tables and seats, and arrives people there", () => {
    expect(layout.spawnZoneId).toBe("nexus-zone");
    for (const t of tables) expect(zoneAt(layout, { x: t.x + t.width / 2, y: t.y + t.height / 2 })).toBeNull();
    for (const s of layout.seats) {
      expect(zoneAt(layout, s.anchor)).toBeNull();
      expect(s.zoneId).toBeUndefined();
    }
  });

  it("keeps the arrival ring in the Nexus clear of furniture (60px spawn ring plus an avatar's width)", () => {
    const clearance = 60 + 20;
    for (const f of layout.furniture) {
      const nx = Math.max(f.x, Math.min(NEXUS_CENTER.x, f.x + f.width));
      const ny = Math.max(f.y, Math.min(NEXUS_CENTER.y, f.y + f.height));
      expect(Math.hypot(nx - NEXUS_CENTER.x, ny - NEXUS_CENTER.y)).toBeGreaterThan(clearance);
    }
  });

  it("fits every seat anchor inside the 18 x 10 tile floor", () => {
    for (const s of layout.seats) {
      expect(s.anchor.x).toBeGreaterThan(0);
      expect(s.anchor.y).toBeGreaterThan(0);
      expect(s.anchor.x).toBeLessThan(18 * TILE_PX);
      expect(s.anchor.y).toBeLessThan(10 * TILE_PX);
    }
  });
});

describe("Cosmic Campus — 100: registration", () => {
  it("is registered under its own id, loadable from a room's config, without changing the default", () => {
    expect(resolveLayout(COSMIC_CAMPUS_100_ID)).toBe(layout);
    expect(listLayoutIds()).toContain(COSMIC_CAMPUS_100_ID);
    expect(DEFAULT_LAYOUT_ID).toBe("office300@1");
    expect(parseRoomConfig({ layoutId: COSMIC_CAMPUS_100_ID })).toEqual({ layoutId: COSMIC_CAMPUS_100_ID });
    expect(LAYOUT_LABELS[COSMIC_CAMPUS_100_ID]).toBe("Cosmic Campus — 100");
  });
});
