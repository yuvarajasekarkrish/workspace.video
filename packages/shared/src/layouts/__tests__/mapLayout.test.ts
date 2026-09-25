import { describe, it, expect } from "vitest";
import { layoutFromMapZones, SPATIAL_MAP_DEFAULT_ZONES, type MapZone } from "../mapLayout";
import { validateLayout } from "../validate";
import { resolveLayout, listLayoutIds, DEFAULT_LAYOUT_ID } from "../registry";
import { zoneAt } from "../queries";
import { TILE_PX, movementConfigForLayout } from "../grid";
import { DEFAULT_MOVEMENT_CONFIG } from "../../proximity-config";

// The spatial map (the owner's Gemini design) written as data the realtime engine can run.
// A map area is a rectangle on the engine's 160 px grid; a desk pod has four seats; the
// numbers below are the same as the drawn map, so the engine and the screen agree.
//
// Not a registered named layout (no room selects it by id — a company's own map is stored
// and rebuilt fresh via layoutFromMapZones, never looked up in the registry) — built here
// purely as a test fixture to exercise the shared conversion engine SPATIAL_MAP_DEFAULT_ZONES
// feeds in production.
const spatialMap1 = layoutFromMapZones("spatialMap@1", SPATIAL_MAP_DEFAULT_ZONES);

const zone = (id: string) => SPATIAL_MAP_DEFAULT_ZONES.find((z) => z.id === id)!;
const seatsOf = (zoneId: string) => spatialMap1.seats.filter((s) => s.zoneId === `${zoneId}-zone`);

describe("spatialMap1: the map as an engine layout", () => {
  it("passes the same structural checks as every other layout", () => {
    const result = validateLayout(spatialMap1);
    if (!result.valid) expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });

  it("is not a registered named layout — a company's own map is rebuilt fresh, never looked up by id", () => {
    expect(resolveLayout("spatialMap@1")).toBeNull();
    expect(listLayoutIds()).toContain(DEFAULT_LAYOUT_ID);
    expect(listLayoutIds()).not.toContain("spatialMap@1");
    expect(listLayoutIds().some((id) => id.startsWith("spatialMap"))).toBe(false);
  });

  it("has one engine zone per map area, arriving in the welcome plaza", () => {
    expect(spatialMap1.zones).toHaveLength(SPATIAL_MAP_DEFAULT_ZONES.length);
    expect(spatialMap1.spawnZoneId).toBe("hub-zone");
    expect(spatialMap1.zones.find((z) => z.id === "hub-zone")?.kind).toBe("lobby");
    expect(spatialMap1.zones.find((z) => z.id === "meet_1-zone")?.kind).toBe("meeting");
    expect(spatialMap1.zones.find((z) => z.id === "focus_pod-zone")?.kind).toBe("focus");
    expect(spatialMap1.zones.find((z) => z.id === "eng-zone")?.kind).toBe("open");
  });

  it("gives each desk pod four seats, as drawn: 32, 24 and 24 seats in the three desk areas", () => {
    expect(seatsOf("eng")).toHaveLength(32);
    expect(seatsOf("prod")).toHaveLength(24);
    expect(seatsOf("sales")).toHaveLength(24);
  });

  it("seats the other areas as drawn: focus pods 8, boardroom 8, sync room 4, lounge 5, none in the plaza or studio", () => {
    expect(seatsOf("focus_pod")).toHaveLength(8);
    expect(seatsOf("meet_1")).toHaveLength(8);
    expect(seatsOf("meet_2")).toHaveLength(4);
    expect(seatsOf("cafe")).toHaveLength(5);
    expect(seatsOf("hub")).toHaveLength(0);
    expect(seatsOf("design")).toHaveLength(0);
    expect(spatialMap1.seats).toHaveLength(105);
  });

  it("puts the first desk pod's four seats exactly where the map draws them", () => {
    // eng starts at tile (1,1) = (160,160) and is 960 x 480; the first pod sits at (30 + 20, 60 + 20)
    // inside it, and its seats are at (43,8) (43,132) (93,8) (93,132) inside the pod.
    const anchors = seatsOf("eng").slice(0, 4).map((s) => s.anchor);
    expect(anchors).toEqual([
      { x: 160 + 50 + 43, y: 160 + 80 + 8 },
      { x: 160 + 50 + 43, y: 160 + 80 + 132 },
      { x: 160 + 50 + 93, y: 160 + 80 + 8 },
      { x: 160 + 50 + 93, y: 160 + 80 + 132 },
    ]);
  });

  it("puts every seat inside the area it belongs to, so audio and counts see seated people", () => {
    for (const seat of spatialMap1.seats) {
      expect(zoneAt(spatialMap1, seat.anchor)?.id, `${seat.id} at ${seat.anchor.x},${seat.anchor.y}`).toBe(seat.zoneId);
    }
  });

  it("never stacks two seats on the same spot, or closer than an avatar's width", () => {
    const seats = spatialMap1.seats;
    let closest = Infinity;
    for (let i = 0; i < seats.length; i++) {
      for (let j = i + 1; j < seats.length; j++) {
        closest = Math.min(closest, Math.hypot(seats[i]!.anchor.x - seats[j]!.anchor.x, seats[i]!.anchor.y - seats[j]!.anchor.y));
      }
    }
    expect(closest).toBeGreaterThanOrEqual(50);
  });

  it("has a floor big enough for every area, and the engine's walking limits follow it", () => {
    for (const z of SPATIAL_MAP_DEFAULT_ZONES) {
      expect(z.rect.col + z.rect.cols).toBeLessThanOrEqual(spatialMap1.floor.cols);
      expect(z.rect.row + z.rect.rows).toBeLessThanOrEqual(spatialMap1.floor.rows);
    }
    const movement = movementConfigForLayout(spatialMap1, DEFAULT_MOVEMENT_CONFIG);
    expect(movement.roomWidthPx).toBe(spatialMap1.floor.cols * TILE_PX);
    expect(movement.roomHeightPx).toBe(spatialMap1.floor.rows * TILE_PX);
  });

  it("keeps the drawn map's people count: the areas add up to 200 places to stand or sit", () => {
    expect(SPATIAL_MAP_DEFAULT_ZONES.reduce((sum, z) => sum + z.targetUsers, 0)).toBe(200);
  });

  it("does not change the shared map data when converted again", () => {
    const before = JSON.stringify(SPATIAL_MAP_DEFAULT_ZONES);
    layoutFromMapZones("another@1", SPATIAL_MAP_DEFAULT_ZONES);
    expect(JSON.stringify(SPATIAL_MAP_DEFAULT_ZONES)).toBe(before);
    expect(zone("eng").rect).toEqual({ col: 1, row: 1, cols: 6, rows: 3 });
  });
});

describe("layoutFromMapZones: what a company's builder will save", () => {
  const small = (over: Partial<MapZone> = {}): MapZone => ({
    id: "z1",
    type: "desks",
    name: "Team",
    rect: { col: 0, row: 0, cols: 6, rows: 3 },
    targetUsers: 10,
    ...over,
  });

  it("refuses an empty map, because a room needs somewhere to arrive", () => {
    expect(() => layoutFromMapZones("empty@1", [])).toThrow(/at least one area/i);
  });

  it("arrives in the first area when there is no plaza", () => {
    expect(layoutFromMapZones("one@1", [small()]).spawnZoneId).toBe("z1-zone");
  });

  it("gives an area too small for a desk pod no seats instead of failing", () => {
    const layout = layoutFromMapZones("tiny@1", [small({ rect: { col: 0, row: 0, cols: 1, rows: 1 } })]);
    expect(layout.seats).toHaveLength(0);
    expect(validateLayout(layout).valid).toBe(true);
  });

  it("reports two meeting rooms that overlap, as the engine's structural check does", () => {
    const layout = layoutFromMapZones("overlap@1", [
      small({ id: "a", type: "meeting" as const, rect: { col: 0, row: 0, cols: 3, rows: 3 } }),
      small({ id: "b", type: "meeting" as const, rect: { col: 2, row: 0, cols: 3, rows: 3 } }),
    ]);
    const result = validateLayout(layout);
    expect(result.valid).toBe(false);
  });
});

describe("spatialMap1: the furniture, so the map looks like an office when drawn", () => {
  const worldBox = (z: { rect: { col: number; row: number; cols: number; rows: number } }) => ({
    x: z.rect.col * TILE_PX,
    y: z.rect.row * TILE_PX,
    right: (z.rect.col + z.rect.cols) * TILE_PX,
    bottom: (z.rect.row + z.rect.rows) * TILE_PX,
  });
  const inside = (p: { x: number; y: number; width: number; height: number }, b: ReturnType<typeof worldBox>) =>
    p.x >= b.x && p.y >= b.y && p.x + p.width <= b.right && p.y + p.height <= b.bottom;

  it("draws desks, chairs, tables, counters, sofas and whiteboards from the areas", () => {
    const kinds = new Set(spatialMap1.furniture.map((f) => f.kind));
    for (const kind of ["desk", "chair", "table", "counter", "sofa", "whiteboard"] as const) expect(kinds.has(kind), kind).toBe(true);
  });

  it("puts a chair under every seat, so a seat is never an empty spot on the floor", () => {
    const chairs = spatialMap1.furniture.filter((f) => f.kind === "chair").map((f) => ({ x: f.x + f.width / 2, y: f.y + f.height / 2 }));
    for (const seat of spatialMap1.seats) {
      const near = chairs.some((c) => Math.hypot(c.x - seat.anchor.x, c.y - seat.anchor.y) <= 20);
      expect(near, `${seat.id} at ${seat.anchor.x},${seat.anchor.y}`).toBe(true);
    }
  });

  it("draws one desk for each desk pod: 20 pods across the three desk areas", () => {
    const podDesks = spatialMap1.furniture.filter((f) => f.kind === "desk" && f.id.includes("-pod-"));
    expect(podDesks).toHaveLength(20);
  });

  it("keeps every piece inside one of the map's areas, so nothing is drawn out in the open floor", () => {
    const boxes = SPATIAL_MAP_DEFAULT_ZONES.map(worldBox);
    for (const piece of spatialMap1.furniture) {
      expect(boxes.some((b) => inside(piece, b)), `${piece.id} at ${piece.x},${piece.y}`).toBe(true);
    }
  });

  it("stays a modest number of pieces, because the fixed floor is drawn once and every piece costs memory", () => {
    expect(spatialMap1.furniture.length).toBeGreaterThan(60);
    expect(spatialMap1.furniture.length).toBeLessThanOrEqual(200);
  });
});

describe("layoutFromMapZones: furniture in very small areas", () => {
  const kinds = ["desks", "creative", "hub", "cafe", "meeting", "focus"] as const;

  it("never draws a piece outside the floor, whatever the area type, even when the area is one tile", () => {
    for (const type of kinds) {
      for (const rect of [{ col: 0, row: 0, cols: 1, rows: 1 }, { col: 3, row: 2, cols: 1, rows: 2 }, { col: 0, row: 0, cols: 2, rows: 1 }]) {
        const layout = layoutFromMapZones("small@1", [{ id: "a", type, name: "Small", rect, targetUsers: 6 }]);
        const result = validateLayout(layout);
        expect(result.valid, `${type} ${JSON.stringify(rect)}: ${result.valid ? "" : result.errors.join("; ")}`).toBe(true);
      }
    }
  });
});
