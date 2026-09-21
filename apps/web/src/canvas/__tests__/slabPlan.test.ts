import { describe, it, expect } from "vitest";
import { resolveLayout, TILE_PX, type FurniturePiece, type RoomLayout } from "@workspace-video/shared";
import { GROUP_PAD, MIN_SEEDS_TO_SPLIT, planFloor, slabAt } from "../slabPlan";

// The floor is drawn as raisable plates: an area with several desks becomes one small plate per desk group (empty
// floor between them, like the Gemini map); an area with one or two pieces stays one plate. Drawing only: the layout
// and seats are never changed, and any template goes through the same rule.

const company = resolveLayout("spatialMap@1")!;
const office = resolveLayout("openOffice@1")!;

const piece = (id: string, kind: FurniturePiece["kind"], x: number, y: number, width: number, height: number): FurniturePiece => ({
  id,
  kind,
  x,
  y,
  width,
  height,
  rotation: 0,
});

const oneAreaWith = (furniture: FurniturePiece[]): RoomLayout =>
  ({ id: "t", zones: [{ id: "z", label: "Z", kind: "open", rect: { col: 0, row: 0, cols: 8, rows: 6 } }], seats: [], furniture }) as unknown as RoomLayout;

describe("planFloor: which areas are cut into desk groups", () => {
  it("keeps an area with fewer than three desks or tables as one plate that holds all its furniture", () => {
    const layout = oneAreaWith([piece("t1", "table", 300, 300, 400, 200), piece("c1", "chair", 300, 250, 32, 32), piece("c2", "chair", 500, 510, 32, 32)]);
    const plan = planFloor(layout);
    expect(plan.slabs).toHaveLength(1);
    expect(plan.slabs[0].id).toBe("z");
    expect(plan.slabs[0].isGroup).toBe(false);
    expect(plan.slabs[0].pieces.sort()).toEqual([0, 1, 2]);
    expect(plan.splitZoneIds.has("z")).toBe(false);
    expect(MIN_SEEDS_TO_SPLIT).toBe(3);
  });

  it("cuts an area with several separate desks into one plate per desk, each carrying its own chairs", () => {
    const desks = [0, 1, 2].map((n) => piece(`d${n}`, "desk", 100 + n * 360, 200, 100, 100));
    const chairs = [0, 1, 2].map((n) => piece(`c${n}`, "chair", 100 + n * 360 + 34, 160, 32, 32)); // just above each desk
    const plan = planFloor(oneAreaWith([...desks, ...chairs]));
    expect(plan.slabs).toHaveLength(3);
    for (const slab of plan.slabs) {
      expect(slab.isGroup).toBe(true);
      expect(slab.pieces).toHaveLength(2); // one desk, one chair
    }
    expect(plan.splitZoneIds.has("z")).toBe(true);
  });

  it("joins desks that touch into one group", () => {
    const layout = oneAreaWith([piece("a", "desk", 100, 100, 100, 100), piece("b", "desk", 200, 100, 100, 100), piece("c", "desk", 900, 100, 100, 100), piece("d", "desk", 900, 500, 100, 100)]);
    expect(planFloor(layout).slabs).toHaveLength(3);
  });

  it("leaves furniture that is far from every desk lying loose on the floor", () => {
    const layout = oneAreaWith([piece("a", "desk", 100, 100, 100, 100), piece("b", "desk", 500, 100, 100, 100), piece("c", "desk", 900, 100, 100, 100), piece("p", "plant", 1100, 700, 40, 40)]);
    const plan = planFloor(layout);
    expect(plan.loosePieces).toContain(3);
  });

  it("gives every piece of furniture exactly one home: a plate or the loose floor", () => {
    for (const layout of [company, office]) {
      const plan = planFloor(layout);
      const homes = [...plan.slabs.flatMap((s) => s.pieces), ...plan.loosePieces].sort((a, b) => a - b);
      expect(homes).toEqual(layout.furniture.map((_, i) => i));
    }
  });
});

describe("planFloor on the company map", () => {
  const plan = planFloor(company);

  it("shows each desk pod as its own plate, with more plates than areas", () => {
    expect(plan.slabs.length).toBeGreaterThan(company.zones.length);
    expect(plan.slabs.filter((s) => s.isGroup).length).toBeGreaterThan(10);
  });

  it("gives every seat a plate, so a person sitting down is raised with their desk", () => {
    for (const seat of company.seats) {
      expect(slabAt(plan, seat.anchor), seat.id).not.toBeNull();
    }
  });

  it("never draws two desk groups on top of each other, and keeps a walkway between neighbours", () => {
    const groups = plan.slabs.filter((s) => s.isGroup);
    for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        const A = groups[a].rect;
        const B = groups[b].rect;
        const apartX = Math.max(B.x - (A.x + A.width), A.x - (B.x + B.width));
        const apartY = Math.max(B.y - (A.y + A.height), A.y - (B.y + B.height));
        expect(Math.max(apartX, apartY), `${groups[a].id} vs ${groups[b].id}`).toBeGreaterThanOrEqual(GROUP_PAD);
      }
    }
  });

  it("keeps every plate inside its own area", () => {
    for (const slab of plan.slabs) {
      const zone = company.zones.find((z) => z.id === slab.zoneId)!;
      expect(slab.rect.x).toBeGreaterThanOrEqual(zone.rect.col * TILE_PX);
      expect(slab.rect.y).toBeGreaterThanOrEqual(zone.rect.row * TILE_PX);
      expect(slab.rect.x + slab.rect.width).toBeLessThanOrEqual((zone.rect.col + zone.rect.cols) * TILE_PX);
      expect(slab.rect.y + slab.rect.height).toBeLessThanOrEqual((zone.rect.row + zone.rect.rows) * TILE_PX);
    }
  });

  it("uses the same plate ids every time, so a raised plate stays the same plate", () => {
    expect(planFloor(company).slabs.map((s) => s.id)).toEqual(plan.slabs.map((s) => s.id));
  });
});

describe("slabAt", () => {
  it("finds the plate under a floor position, and none over bare floor", () => {
    const layout = oneAreaWith([piece("a", "desk", 100, 100, 100, 100), piece("b", "desk", 500, 100, 100, 100), piece("c", "desk", 900, 100, 100, 100)]);
    const plan = planFloor(layout);
    expect(slabAt(plan, { x: 150, y: 150 })?.pieces).toEqual([0]);
    expect(slabAt(plan, { x: 700, y: 700 })).toBeNull();
  });
});
