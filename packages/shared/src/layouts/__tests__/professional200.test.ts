import { describe, it, expect } from "vitest";
import { professional200 } from "../professional200";
import { validateLayout } from "../validate";
import { furniturePiecesOverlap } from "../collision";
import { resolveLayout, DEFAULT_LAYOUT_ID, listLayoutIds } from "../registry";
import { openOffice1 } from "../openOffice";
import type { FurniturePiece } from "../types";

describe("professional200", () => {
  it("passes structural validation", () => {
    const result = validateLayout(professional200);
    if (!result.valid) {
      expect(result.errors).toEqual([]);
    }
    expect(result.valid).toBe(true);
  });

  it("has zero UNINTENTIONAL overlapping furniture anywhere in the whole assembled floor - not just within one module", () => {
    // The real answer to "does everything fit without collisions": every
    // piece checked against every other piece in the ENTIRE layout, using
    // the same rotated-rectangle SAT check (collision.ts) proven earlier
    // this session, not an eyeballed tile-grid layout.
    //
    // Two kinds of overlap are real and expected, not bugs, and are excluded
    // by id pattern rather than silenced blindly:
    // - A desk's own monitor sits ON the desk's surface (same real-world
    //   footprint from above) - "<deskId> <-> <deskId>-monitor".
    // - A phone booth's three walls meet at shared corners, and the open
    //   front's door marker sits flush against the two side walls - any pair
    //   of pieces belonging to the SAME booth id prefix.
    // - A seat divider straddles its own row's bench (the same physical
    //   surface, by construction always the divider's own row - benchRows
    //   never places a divider against any bench but its own) - any
    //   "-divider" id overlapping a "table"-kind piece from the same layout
    //   section (idPrefix).
    const isExpectedOverlap = (a: FurniturePiece, b: FurniturePiece): boolean => {
      if (a.id.endsWith("-monitor") && b.id === a.id.replace(/-monitor$/, "")) return true;
      if (b.id.endsWith("-monitor") && a.id === b.id.replace(/-monitor$/, "")) return true;
      const boothPrefix = (id: string) => /^(booth-\d+)-/.exec(id)?.[1];
      if (boothPrefix(a.id) && boothPrefix(a.id) === boothPrefix(b.id)) return true;
      const sectionPrefix = (id: string) => id.split("-")[0];
      const isDividerBench = (x: FurniturePiece, y: FurniturePiece) =>
        x.id.endsWith("-divider") && y.kind === "table" && sectionPrefix(x.id) === sectionPrefix(y.id);
      if (isDividerBench(a, b) || isDividerBench(b, a)) return true;
      // The screen mounts right where the stage riser's front lip begins -
      // both from stageAndScreen's shared block, a real stage's screen and
      // platform meeting at one edge, not two unrelated pieces colliding.
      if (a.id.endsWith("-stage-riser") && b.id.endsWith("-screen") && sectionPrefix(a.id) === sectionPrefix(b.id)) return true;
      if (b.id.endsWith("-stage-riser") && a.id.endsWith("-screen") && sectionPrefix(a.id) === sectionPrefix(b.id)) return true;
      return false;
    };

    const pieces = professional200.furniture;
    const overlaps: string[] = [];
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        const a = pieces[i]!;
        const b = pieces[j]!;
        if (isExpectedOverlap(a, b)) continue;
        if (furniturePiecesOverlap(a, b)) overlaps.push(`${a.id} <-> ${b.id}`);
      }
    }
    expect(overlaps).toEqual([]);
  });

  it("has zero overlapping zone tile-rects anywhere on the floor, not only the kinds validateLayout itself checks", () => {
    // validateLayout only checks meeting/cabin/stage/audience zones against
    // each other; this proves the FULL zone set (including every "open"
    // zone - reception tables, kitchen, lounges) never shares a tile either,
    // since every module in this layout got its own exclusive tile block.
    const tilesOverlap = (a: typeof professional200.zones[number]["rect"], b: typeof professional200.zones[number]["rect"]) =>
      a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows;
    const zones = professional200.zones;
    const overlaps: string[] = [];
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        if (tilesOverlap(zones[i]!.rect, zones[j]!.rect)) {
          overlaps.push(`${zones[i]!.id} <-> ${zones[j]!.id}`);
        }
      }
    }
    expect(overlaps).toEqual([]);
  });

  it("has exactly 301 real seats, well above the 200-person plan cap, with deliberate headroom", () => {
    expect(professional200.seats.length).toBe(301);
  });

  it("breaks down seat counts per area exactly as designed", () => {
    const byLabelPrefix = (prefix: string) => professional200.seats.filter((s) => s.label.startsWith(prefix)).length;
    expect(byLabelPrefix("Auditorium")).toBe(80); // 8 rows x 10 seats
    expect(byLabelPrefix("Pod ")).toBe(128); // 16 pods x 8 seats
    expect(byLabelPrefix("Cabin Table")).toBe(24); // 4 tables x 6 seats
    expect(byLabelPrefix("Lounge")).toBe(9 + 16); // straight lounge (9) + round lounge pit (16, same "Lounge" label)
    expect(byLabelPrefix("Reception")).toBe(16); // 4 tables x 4 seats
    expect(byLabelPrefix("Meeting Room")).toBe(16); // 2 rooms x 8 seats
    expect(byLabelPrefix("Kitchen")).toBe(12);
  });

  it("has no seat belonging to a phone booth - booths are standing, capacity tracked at the zone only", () => {
    const boothZoneIds = new Set(professional200.zones.filter((z) => z.kind === "focus").map((z) => z.id));
    expect(boothZoneIds.size).toBe(6);
    expect(professional200.seats.some((s) => s.zoneId && boothZoneIds.has(s.zoneId))).toBe(false);
  });

  it("every audience seat's zone points at a real stage zone", () => {
    const audience = professional200.zones.find((z) => z.kind === "audience");
    expect(audience).toBeDefined();
    const stage = professional200.zones.find((z) => z.id === audience!.stageId);
    expect(stage?.kind).toBe("stage");
  });

  it("spawnZoneId resolves to a real zone", () => {
    expect(professional200.zones.some((z) => z.id === professional200.spawnZoneId)).toBe(true);
  });

  it("is registered under its own id and does not disturb the existing default layout", () => {
    expect(resolveLayout("professional200@1")?.id).toBe("professional200@1");
    expect(DEFAULT_LAYOUT_ID).toBe("openOffice@1"); // unchanged - additive per rule 19/20
    expect(resolveLayout(DEFAULT_LAYOUT_ID)?.id).toBe(openOffice1.id);
    expect(listLayoutIds()).toContain("professional200@1");
    expect(listLayoutIds()).toContain("openOffice@1");
  });
});
