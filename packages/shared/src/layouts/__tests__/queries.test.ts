import { describe, it, expect } from "vitest";
import type { RoomLayout } from "../types";
import { zoneAt, seatById, hitTestSeats, parseRoomConfig } from "../queries";
import { movementConfigForLayout, TILE_PX } from "../grid";
import { DEFAULT_LAYOUT_ID } from "../registry";
import { openOffice1 } from "../openOffice";

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
    const seat = openOffice1.seats.find((s) => s.label === "Desk 1");
    expect(seat).toBeDefined();
    expect(seatById(openOffice1, seat!.id)).toEqual(seat);
  });

  it("returns undefined for an unknown seat id", () => {
    expect(seatById(openOffice1, "no-such-seat")).toBeUndefined();
  });

  it("hitTestSeats finds the nearest seat within the radius", () => {
    const seat = openOffice1.seats[0]!;
    const hit = hitTestSeats(openOffice1, { x: seat.anchor.x + 2, y: seat.anchor.y - 2 });
    expect(hit?.id).toBe(seat.id);
  });

  it("hitTestSeats returns null when nothing is within radius", () => {
    const hit = hitTestSeats(openOffice1, { x: -10_000, y: -10_000 });
    expect(hit).toBeNull();
  });
});

describe("movementConfigForLayout", () => {
  it("derives room bounds from the layout's floor size", () => {
    const config = movementConfigForLayout(openOffice1, { clientThrottleMs: 50, maxSpeedPxPerSec: 2000, maxBurstMs: 200 });
    expect(config.roomWidthPx).toBe(openOffice1.floor.cols * TILE_PX);
    expect(config.roomHeightPx).toBe(openOffice1.floor.rows * TILE_PX);
    expect(config.clientThrottleMs).toBe(50);
    expect(config.maxSpeedPxPerSec).toBe(2000);
  });
});

describe("parseRoomConfig", () => {
  it("resolves a valid, known layoutId", () => {
    expect(parseRoomConfig({ layoutId: "openOffice@1" })).toEqual({ layoutId: "openOffice@1" });
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
