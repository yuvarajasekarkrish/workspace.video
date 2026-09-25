import { describe, it, expect } from "vitest";
import type { RoomLayout } from "../types";
import { zoneAt, seatById, hitTestSeats, parseRoomConfig, tableGroupIdForSeat, seatsAtSameTable, furnitureAt } from "../queries";
import { movementConfigForLayout, TILE_PX } from "../grid";
import { DEFAULT_LAYOUT_ID } from "../registry";
import { office300 } from "../office300";

describe("zoneAt", () => {
  const layout: RoomLayout = {
    id: "test@1",
    floor: { cols: 10, rows: 10 },
    spawnZoneId: "outer",
    furniture: [],
    seats: [],
    zones: [
      { id: "outer", label: "Outer", kind: "open", rect: { col: 0, row: 0, cols: 10, rows: 10 } },
      { id: "inner", label: "Inner", kind: "meeting", rect: { col: 2, row: 2, cols: 2, rows: 2 } },
    ],
  };

  it("returns the smallest zone containing the point when zones are nested", () => {
    // (2*160+10, 2*160+10) = (330,330), inside both outer and inner.
    const zone = zoneAt(layout, { x: 330, y: 330 });
    expect(zone?.id).toBe("inner");
  });

  it("returns the outer zone for a point outside the inner one", () => {
    const zone = zoneAt(layout, { x: 5, y: 5 });
    expect(zone?.id).toBe("outer");
  });

  it("returns null outside every zone", () => {
    expect(zoneAt(layout, { x: -50, y: -50 })).toBeNull();
  });

  it("treats the far edge as exclusive (matches TileRect bounds)", () => {
    const box = { x: 10 * TILE_PX, y: 10 * TILE_PX };
    expect(zoneAt(layout, box)).toBeNull();
  });
});

describe("seatById / hitTestSeats", () => {
  it("finds a known seat by id", () => {
    const seat = office300.seats.find((s) => s.label === "Desk 1");
    expect(seat).toBeDefined();
    expect(seatById(office300, seat!.id)).toEqual(seat);
  });

  it("returns undefined for an unknown seat id", () => {
    expect(seatById(office300, "no-such-seat")).toBeUndefined();
  });

  it("hitTestSeats finds the nearest seat within the radius", () => {
    const seat = office300.seats[0]!;
    const hit = hitTestSeats(office300, { x: seat.anchor.x + 2, y: seat.anchor.y - 2 });
    expect(hit?.id).toBe(seat.id);
  });

  it("hitTestSeats returns null when nothing is within radius", () => {
    const hit = hitTestSeats(office300, { x: -10_000, y: -10_000 });
    expect(hit).toBeNull();
  });

  it("a click on the desk's own table surface misses — only a click on the chair itself claims a seat", () => {
    // A desk's table center sits at the midpoint between its two chairs
    // (see modules.ts's deskGrid: cx/cy is the desk center, chairs are
    // offset chairGap = DESK_SIZE/2 + CHAIR_SIZE/2 + 6 = 61px either side)
    // — well beyond hitTestSeats' default 28px click-to-sit radius, so
    // clicking the table itself must never accidentally seat you.
    const [seatA, seatB] = office300.seats.filter((s) => s.label === "Desk 1");
    const tableCenter = { x: (seatA!.anchor.x + seatB!.anchor.x) / 2, y: (seatA!.anchor.y + seatB!.anchor.y) / 2 };
    expect(Math.hypot(tableCenter.x - seatA!.anchor.x, tableCenter.y - seatA!.anchor.y)).toBeGreaterThan(28);

    expect(hitTestSeats(office300, tableCenter)).toBeNull();
    expect(hitTestSeats(office300, seatA!.anchor)?.id).toBe(seatA!.id);
    expect(hitTestSeats(office300, seatB!.anchor)?.id).toBe(seatB!.id);
  });
});

describe("tableGroupIdForSeat / seatsAtSameTable", () => {
  it("groups a real desk's two seats under one table id", () => {
    const [seatA, seatB] = office300.seats.filter((s) => s.label === "Desk 1");
    expect(tableGroupIdForSeat(seatA!.id)).toBe(tableGroupIdForSeat(seatB!.id));

    const group = seatsAtSameTable(office300, seatA!.id);
    expect(group.map((s) => s.id).sort()).toEqual([seatA!.id, seatB!.id].sort());
  });

  it("does not group two different desks together", () => {
    const desk1 = office300.seats.find((s) => s.label === "Desk 1")!;
    const desk2 = office300.seats.find((s) => s.label === "Desk 2")!;
    expect(tableGroupIdForSeat(desk1.id)).not.toBe(tableGroupIdForSeat(desk2.id));
  });

  it("returns an empty array for an unknown seat id", () => {
    expect(seatsAtSameTable(office300, "no-such-seat")).toEqual([]);
  });

  it("groups every seat at a real many-seat table (Boardroom), not just 2-seat desks", () => {
    const boardroomSeats = office300.seats.filter((s) => s.zoneId === "meet-a-zone");
    expect(boardroomSeats.length).toBe(20);
    const group = seatsAtSameTable(office300, boardroomSeats[0]!.id);
    expect(group.length).toBe(20);
  });
});

describe("seatsAtSameTable with explicit tableId", () => {
  const base: RoomLayout = { id: "t@1", floor: { cols: 4, rows: 4 }, spawnZoneId: "z", furniture: [], seats: [], zones: [] };

  it("groups by tableId, not by seat-id naming", () => {
    const layout: RoomLayout = {
      ...base,
      seats: [
        { id: "alpha", label: "A", anchor: { x: 0, y: 0 }, tableId: "table-1" },
        { id: "bravo-x", label: "A", anchor: { x: 1, y: 0 }, tableId: "table-1" },
        { id: "charlie", label: "A", anchor: { x: 2, y: 0 }, tableId: "table-1" },
      ],
    };
    expect(seatsAtSameTable(layout, "alpha").map((s) => s.id)).toEqual(["alpha", "bravo-x", "charlie"]);
  });

  it("separates seats whose ids share a prefix but whose tableIds differ", () => {
    const layout: RoomLayout = {
      ...base,
      seats: [
        { id: "desk-1-a", label: "A", anchor: { x: 0, y: 0 }, tableId: "t1" },
        { id: "desk-1-b", label: "A", anchor: { x: 1, y: 0 }, tableId: "t2" },
      ],
    };
    expect(seatsAtSameTable(layout, "desk-1-a").map((s) => s.id)).toEqual(["desk-1-a"]);
  });

  it("never mixes explicit and prefix-grouped seats", () => {
    const layout: RoomLayout = {
      ...base,
      seats: [
        { id: "desk-1-a", label: "A", anchor: { x: 0, y: 0 } },
        { id: "desk-1-b", label: "A", anchor: { x: 1, y: 0 }, tableId: "desk-1" },
      ],
    };
    expect(seatsAtSameTable(layout, "desk-1-a").map((s) => s.id)).toEqual(["desk-1-a"]);
    expect(seatsAtSameTable(layout, "desk-1-b").map((s) => s.id)).toEqual(["desk-1-b"]);
  });

  it("leaves office300's prefix grouping exactly as before (no seat there has a tableId)", () => {
    expect(office300.seats.every((s) => s.tableId === undefined)).toBe(true);
    const [seatA, seatB] = office300.seats.filter((s) => s.label === "Desk 1");
    expect(seatsAtSameTable(office300, seatA!.id).map((s) => s.id).sort()).toEqual([seatA!.id, seatB!.id].sort());
  });
});

describe("furnitureAt", () => {
  it("finds the desk furniture piece under a click on its table surface", () => {
    const [seatA, seatB] = office300.seats.filter((s) => s.label === "Desk 1");
    const tableCenter = { x: (seatA!.anchor.x + seatB!.anchor.x) / 2, y: (seatA!.anchor.y + seatB!.anchor.y) / 2 };
    const piece = furnitureAt(office300, tableCenter);
    expect(piece?.kind).toBe("desk");
    expect(piece?.label).toBe("Desk 1");
  });

  it("returns null for a point on bare floor", () => {
    expect(furnitureAt(office300, { x: -10_000, y: -10_000 })).toBeNull();
  });
});

describe("movementConfigForLayout", () => {
  it("derives room bounds from the layout's floor size", () => {
    const config = movementConfigForLayout(office300, { clientThrottleMs: 50, maxSpeedPxPerSec: 2000, maxBurstMs: 200 });
    expect(config.roomWidthPx).toBe(office300.floor.cols * TILE_PX);
    expect(config.roomHeightPx).toBe(office300.floor.rows * TILE_PX);
    expect(config.clientThrottleMs).toBe(50);
    expect(config.maxSpeedPxPerSec).toBe(2000);
  });
});

describe("parseRoomConfig", () => {
  it("resolves a valid, known layoutId", () => {
    expect(parseRoomConfig({ layoutId: "office300@1" })).toEqual({ layoutId: "office300@1" });
  });

  it("falls back to the default layout when layoutId is missing", () => {
    expect(parseRoomConfig({})).toEqual({ layoutId: DEFAULT_LAYOUT_ID });
  });

  it("falls back to the default layout when layoutId is unknown", () => {
    expect(parseRoomConfig({ layoutId: "does-not-exist@99" })).toEqual({ layoutId: DEFAULT_LAYOUT_ID });
  });

  it("falls back to the default layout for malformed config", () => {
    expect(parseRoomConfig(null)).toEqual({ layoutId: DEFAULT_LAYOUT_ID });
    expect(parseRoomConfig("not an object")).toEqual({ layoutId: DEFAULT_LAYOUT_ID });
    expect(parseRoomConfig({ layoutId: 123 })).toEqual({ layoutId: DEFAULT_LAYOUT_ID });
  });
});
