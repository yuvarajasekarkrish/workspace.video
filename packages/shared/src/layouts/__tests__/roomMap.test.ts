import { describe, it, expect } from "vitest";
import {
  validateRoomMap,
  resolveRoomLayout,
  MAX_FLOOR_TILES,
  MAX_MAP_ZONES,
  MAX_MAP_SEATS,
  type RoomMap,
} from "../roomMap";
import { SPATIAL_MAP_DEFAULT_ZONES, spatialMap1, type MapZone } from "../mapLayout";
import { openOffice1 } from "../openOffice";
import { validateLayout } from "../validate";
import { resolveLayout } from "../registry";
import { parseRoomConfig } from "../queries";

// A company's map arrives from the admin panel, so it is untrusted input: it is checked when saved
// and again when loaded, and a broken one must never change the office silently (decision D6, D7 in
// docs/architecture/company-map-builder.md).

const starter = (): RoomMap => ({ version: 1, zones: SPATIAL_MAP_DEFAULT_ZONES.map((z) => ({ ...z, rect: { ...z.rect } })) });
const zone = (over: Partial<MapZone> = {}): MapZone => ({
  id: "z1",
  type: "creative",
  name: "Studio",
  rect: { col: 0, row: 0, cols: 2, rows: 2 },
  targetUsers: 5,
  ...over,
});
const errorsOf = (input: unknown): string => {
  const result = validateRoomMap(input);
  return result.ok ? "" : result.errors.join(" | ");
};

describe("validateRoomMap: what is accepted", () => {
  it("accepts the starter map and compiles it to the same layout as spatialMap@1", () => {
    const result = validateRoomMap(starter());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.layout.floor).toEqual(spatialMap1.floor);
    expect(result.layout.seats).toEqual(spatialMap1.seats);
    expect(result.layout.zones).toEqual(spatialMap1.zones);
    expect(result.layout.spawnZoneId).toBe(spatialMap1.spawnZoneId);
    expect(validateLayout(result.layout).valid).toBe(true);
  });

  it("accepts the largest allowed floor and the most areas allowed", () => {
    const edge = { version: 1, zones: [zone({ rect: { col: 44, row: 44, cols: MAX_FLOOR_TILES - 44, rows: MAX_FLOOR_TILES - 44 } })] };
    expect(validateRoomMap(edge).ok).toBe(true);
    const many = {
      version: 1,
      zones: Array.from({ length: MAX_MAP_ZONES }, (_, i) => zone({ id: `z${i}`, rect: { col: i % 50, row: Math.floor(i / 50), cols: 1, rows: 1 } })),
    };
    expect(validateRoomMap(many).ok).toBe(true);
  });

  it("drops fields it does not know, so nothing extra is stored", () => {
    const input = { version: 1, evil: "x", zones: [{ ...zone(), extra: 1 }] };
    const result = validateRoomMap(input);
    expect(result.ok).toBe(true);
    if (result.ok) expect(JSON.stringify(result.map)).not.toMatch(/evil|extra/);
  });

  it("gives the same answer every time", () => {
    expect(JSON.stringify(validateRoomMap(starter()))).toBe(JSON.stringify(validateRoomMap(starter())));
  });
});

describe("validateRoomMap: what is refused, and the reason given", () => {
  it("refuses anything that is not a map", () => {
    for (const input of [null, undefined, 5, "x", [], {}]) expect(validateRoomMap(input).ok, String(input)).toBe(false);
  });

  it("refuses an unknown version", () => {
    expect(errorsOf({ ...starter(), version: 2 })).toMatch(/version/i);
  });

  it("refuses a map with no areas, and one with too many", () => {
    expect(errorsOf({ version: 1, zones: [] })).toMatch(/at least one area/i);
    const tooMany = { version: 1, zones: Array.from({ length: MAX_MAP_ZONES + 1 }, (_, i) => zone({ id: `z${i}`, rect: { col: i % 50, row: Math.floor(i / 50), cols: 1, rows: 1 } })) };
    expect(errorsOf(tooMany)).toMatch(/at most 60 areas/i);
  });

  it("refuses bad ids, repeated ids and bad names", () => {
    expect(errorsOf({ version: 1, zones: [zone({ id: "Bad Id!" })] })).toMatch(/id/i);
    expect(errorsOf({ version: 1, zones: [zone({ id: "" })] })).toMatch(/id/i);
    expect(errorsOf({ version: 1, zones: [zone({ id: "a" }), zone({ id: "a", rect: { col: 5, row: 5, cols: 1, rows: 1 } })] })).toMatch(/duplicate/i);
    expect(errorsOf({ version: 1, zones: [zone({ name: "" })] })).toMatch(/name/i);
    expect(errorsOf({ version: 1, zones: [zone({ name: "x".repeat(61) })] })).toMatch(/name/i);
  });

  it("refuses areas with a negative, empty, fractional or unreadable position or size", () => {
    for (const rect of [{ col: -1, row: 0, cols: 2, rows: 2 }, { col: 0, row: 0, cols: 0, rows: 2 }, { col: 0.5, row: 0, cols: 2, rows: 2 }, { col: 0, row: 0, cols: Number.NaN, rows: 2 }]) {
      expect(validateRoomMap({ version: 1, zones: [zone({ rect })] }).ok, JSON.stringify(rect)).toBe(false);
    }
  });

  it("refuses a map that reaches past the largest floor", () => {
    expect(errorsOf({ version: 1, zones: [zone({ rect: { col: 49, row: 0, cols: 2, rows: 1 } })] })).toMatch(/larger than.*50/i);
    expect(errorsOf({ version: 1, zones: [zone({ rect: { col: 0, row: 50, cols: 1, rows: 1 } })] })).toMatch(/larger than.*50/i);
  });

  it("refuses two meeting rooms that overlap, and more than one arrival area", () => {
    const overlap = { version: 1, zones: [zone({ id: "a", type: "meeting", rect: { col: 0, row: 0, cols: 3, rows: 3 } }), zone({ id: "b", type: "meeting", rect: { col: 2, row: 0, cols: 3, rows: 3 } })] };
    expect(errorsOf(overlap)).toMatch(/overlap/i);
    const twoHubs = { version: 1, zones: [zone({ id: "a", type: "hub" }), zone({ id: "b", type: "hub", rect: { col: 5, row: 5, cols: 2, rows: 2 } })] };
    expect(errorsOf(twoHubs)).toMatch(/one arrival area/i);
  });

  it("refuses a map with more seats than allowed, without building them first", () => {
    const desks = Array.from({ length: 13 }, (_, i) => zone({ id: `d${i}`, type: "desks", rect: { col: (i % 5) * 9, row: Math.floor(i / 5) * 4, cols: 6, rows: 3 } }));
    expect(errorsOf({ version: 1, zones: desks })).toMatch(new RegExp(`seats.*${MAX_MAP_SEATS}`, "i"));
    // Meeting rooms are counted by their chairs too, so a huge "capacity" cannot slip through.
    const rooms = Array.from({ length: 5 }, (_, i) => zone({ id: `m${i}`, type: "meeting", targetUsers: 200, rect: { col: i * 6, row: 0, cols: 5, rows: 5 } }));
    expect(errorsOf({ version: 1, zones: rooms })).toMatch(/seats/i);
  });

  it("reports every problem it finds, not just the first", () => {
    const result = validateRoomMap({ version: 1, zones: [zone({ id: "Bad Id!", name: "" })] });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });
});

describe("resolveRoomLayout: one place decides a room's layout", () => {
  it("gives the default office for empty, missing or unreadable settings", () => {
    for (const config of [{}, null, undefined, 5, "x", []]) {
      const resolved = resolveRoomLayout(config);
      expect(resolved.layout, String(config)).toBe(openOffice1);
      expect(resolved.source).toBe("default");
      expect(resolved.problem).toBeUndefined();
    }
  });

  it("uses a named layout that exists, and the default for one that does not (as before)", () => {
    expect(resolveRoomLayout({ layoutId: "openOffice@1" })).toMatchObject({ layout: openOffice1, source: "layoutId" });
    expect(resolveRoomLayout({ layoutId: "spatialMap@1" })).toMatchObject({ layout: spatialMap1, source: "layoutId" });
    expect(resolveRoomLayout({ layoutId: "nope@1" })).toMatchObject({ layout: openOffice1, source: "default" });
  });

  it("builds a company's own map from its settings, and it wins over a named layout", () => {
    const resolved = resolveRoomLayout({ layoutId: "openOffice@1", map: starter() });
    expect(resolved.source).toBe("map");
    expect(resolved.layout.id).toBe("custom");
    expect(resolved.layout.seats).toHaveLength(105);
    expect(resolved.problem).toBeUndefined();
  });

  it("falls back to the named layout, or the default, when the stored map is broken, and says why", () => {
    const broken = { version: 1, zones: [] };
    const named = resolveRoomLayout({ layoutId: "spatialMap@1", map: broken });
    expect(named.layout).toBe(spatialMap1);
    expect(named.source).toBe("layoutId");
    expect(named.problem).toMatch(/at least one area/i);
    const bare = resolveRoomLayout({ map: broken });
    expect(bare.layout).toBe(openOffice1);
    expect(bare.source).toBe("default");
    expect(bare.problem).toMatch(/at least one area/i);
  });

  it("never throws, whatever is stored", () => {
    for (const map of [null, 5, "x", [], { zones: "x" }, { version: 1, zones: [null] }, { version: 1, zones: [{ rect: null }] }]) {
      const resolved = resolveRoomLayout({ map });
      expect(resolved.layout.id.length).toBeGreaterThan(0);
      expect(resolved.problem).toBeTruthy();
    }
  });
});

describe("resolveRoomLayout: the same answer as the old lookup for every room that exists today", () => {
  it("matches parseRoomConfig + resolveLayout for rooms with no map", () => {
    const configs: unknown[] = [
      undefined,
      null,
      {},
      [],
      5,
      "x",
      { layoutId: "openOffice@1" },
      { layoutId: "spatialMap@1" },
      { layoutId: "nope@1" },
      { layoutId: 7 },
      { layoutId: "" },
      { layoutId: "openOffice@1", somethingElse: true },
    ];
    for (const config of configs) {
      expect(resolveRoomLayout(config).layout, JSON.stringify(config)).toBe(resolveLayout(parseRoomConfig(config).layoutId));
    }
  });
});
