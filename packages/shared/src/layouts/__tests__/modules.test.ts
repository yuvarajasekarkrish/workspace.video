import { describe, it, expect } from "vitest";
import {
  deskPod,
  deskGrid,
  deskGridFits,
  angledDeskPod,
  benchTable,
  benchRows,
  privateCabin,
  allHands,
  phoneBooth,
  roundTable,
  roundLounge,
} from "../modules";
import { furniturePiecesOverlap } from "../collision";
import type { TileRect } from "../types";

const rect: TileRect = { col: 0, row: 0, cols: 6, rows: 6 };

describe("deskPod", () => {
  it.each([2, 3, 4, 5] as const)("produces n²=%i desks (2 seats each) for n=%i", (n) => {
    const result = deskPod("pod", rect, n, 1);
    const deskCount = result.furniture.filter((f) => f.kind === "desk").length;
    expect(deskCount).toBe(n * n);
    expect(result.seats).toHaveLength(n * n * 2);
  });

  it("numbers desks sequentially starting at startNumber", () => {
    const result = deskPod("pod", rect, 2, 10);
    const labels = new Set(result.furniture.filter((f) => f.kind === "desk").map((f) => f.label));
    expect(labels).toEqual(new Set(["Desk 10", "Desk 11", "Desk 12", "Desk 13"]));
  });

  it("keeps every desk square (width equals height)", () => {
    const result = deskPod("pod", rect, 3, 1);
    for (const f of result.furniture.filter((f) => f.kind === "desk")) {
      expect(f.width).toBe(f.height);
    }
  });
});

describe("deskGrid", () => {
  it("supports a non-square grid (cols != rows)", () => {
    const result = deskGrid("floor", { col: 0, row: 0, cols: 9, rows: 6 }, { cols: 3, rows: 6, startNumber: 1 });
    const deskCount = result.furniture.filter((f) => f.kind === "desk").length;
    expect(deskCount).toBe(18);
    expect(result.seats).toHaveLength(36);
  });
});

describe("deskGridFits", () => {
  it("accepts the real production arrangement (6x6 desks in a 6x6 tile rect)", () => {
    // TILE_PX=160 per cell, same box deskGrid itself divides in production layouts.
    const result = deskGridFits(rect, { cols: 6, rows: 6 });
    expect(result.fits).toBe(true);
    expect(result.cellPx).toEqual({ width: 160, height: 160 });
  });

  it("rejects an admin cramming 40 columns into a 6-tile-wide rect (2x40 example)", () => {
    const result = deskGridFits(rect, { cols: 40, rows: 2 });
    expect(result.fits).toBe(false);
    expect(result.reason).toBe("cell_too_narrow");
  });

  it("rejects an admin cramming 6 columns into a rect too narrow for it (3x6 example)", () => {
    const narrow: TileRect = { col: 0, row: 0, cols: 2, rows: 6 };
    const result = deskGridFits(narrow, { cols: 6, rows: 3 });
    expect(result.fits).toBe(false);
    expect(result.reason).toBe("cell_too_narrow");
  });

  it("rejects too many rows for the available height, independent of width", () => {
    const short: TileRect = { col: 0, row: 0, cols: 6, rows: 1 };
    // 160px tall / 4 rows = 40px per row, under the 76px desk footprint.
    const result = deskGridFits(short, { cols: 6, rows: 4 });
    expect(result.fits).toBe(false);
    expect(result.reason).toBe("cell_too_short");
  });

  it("accepts exactly at the minimum boundary (122px wide cell)", () => {
    // 976px wide / 8 cols = 122px = DESK_SIZE(76) + CHAIR_SIZE(34) + 12 exactly.
    const boundary: TileRect = { col: 0, row: 0, cols: 6.1, rows: 6 };
    const result = deskGridFits(boundary, { cols: 8, rows: 1 });
    expect(result.cellPx.width).toBeCloseTo(122, 5);
    expect(result.fits).toBe(true);
  });

  it("reports both the actual and minimum cell size on failure, for a real error message", () => {
    const result = deskGridFits(rect, { cols: 40, rows: 2 });
    expect(result.fits).toBe(false);
    expect(result.minPx).toEqual({ width: 122, height: 76 });
    expect(result.cellPx.width).toBeCloseTo(24, 5);
  });
});

describe("angledDeskPod", () => {
  const podRect: TileRect = { col: 0, row: 0, cols: 6, rows: 6 };

  it("produces exactly 8 desks, 8 chairs, 8 monitors, 6 partitions and 8 seats", () => {
    const result = angledDeskPod("pod", podRect, 1);
    const byKind = (kind: string) => result.furniture.filter((f) => f.kind === kind);
    expect(byKind("desk")).toHaveLength(8);
    expect(byKind("chair")).toHaveLength(8);
    expect(byKind("screen")).toHaveLength(8);
    expect(byKind("wall")).toHaveLength(6); // 3 gaps per row x 2 rows
    expect(result.seats).toHaveLength(8);
  });

  it("numbers desks and seats sequentially from startNumber", () => {
    const result = angledDeskPod("pod", podRect, 10);
    const labels = new Set(result.furniture.filter((f) => f.kind === "desk").map((f) => f.label));
    expect(labels).toEqual(new Set(["Pod 10", "Pod 11", "Pod 12", "Pod 13", "Pod 14", "Pod 15", "Pod 16", "Pod 17"]));
  });

  it("every desk, monitor and partition carries the pod's rotation", () => {
    const result = angledDeskPod("pod", podRect, 1, -0.2);
    for (const f of result.furniture) {
      if (f.kind === "chair") continue; // chairs face their own desk, not the pod's raw angle
      expect(f.rotation).toBeCloseTo(-0.2, 10);
    }
  });

  it("defaults to the approved artifact's own angle when rotationRad is omitted", () => {
    const result = angledDeskPod("pod", podRect, 1);
    const desk = result.furniture.find((f) => f.kind === "desk")!;
    expect(desk.rotation).toBeCloseTo(-0.2, 10);
  });

  it("every chair faces its own desk's centre (same atan2 rule as every other block)", () => {
    const result = angledDeskPod("pod", podRect, 1);
    const desks = result.furniture.filter((f) => f.kind === "desk");
    const chairs = result.furniture.filter((f) => f.kind === "chair");
    for (const desk of desks) {
      const deskId = desk.id;
      const ownChair = chairs.find((c) => c.id === `${deskId}-chair`)!;
      const deskCentre = { x: desk.x + desk.width / 2, y: desk.y + desk.height / 2 };
      const chairCentre = { x: ownChair.x + ownChair.width / 2, y: ownChair.y + ownChair.height / 2 };
      const expected = Math.atan2(deskCentre.y - chairCentre.y, deskCentre.x - chairCentre.x);
      expect(ownChair.rotation).toBeCloseTo(expected, 10);
    }
  });

  it("no two desks in the pod overlap each other, even rotated", () => {
    const result = angledDeskPod("pod", podRect, 1);
    const desks = result.furniture.filter((f) => f.kind === "desk");
    for (let i = 0; i < desks.length; i++) {
      for (let j = i + 1; j < desks.length; j++) {
        expect(furniturePiecesOverlap(desks[i]!, desks[j]!)).toBe(false);
      }
    }
  });

  it("rotating the whole pod moves every seat's anchor, proving the group rotation actually applies", () => {
    const flat = angledDeskPod("pod", podRect, 1, 0);
    const angled = angledDeskPod("pod", podRect, 1, -0.2);
    expect(flat.seats[0]!.anchor).not.toEqual(angled.seats[0]!.anchor);
  });
});

describe("phoneBooth", () => {
  const boothRect: TileRect = { col: 0, row: 0, cols: 2, rows: 2 };

  it("has no seats - a standing booth, not a seated one", () => {
    const result = phoneBooth("ph", boothRect);
    expect(result.seats).toHaveLength(0);
  });

  it("is built entirely from existing furniture kinds", () => {
    const result = phoneBooth("ph", boothRect);
    const kinds = new Set(result.furniture.map((f) => f.kind));
    expect(kinds).toEqual(new Set(["wall", "counter", "door"]));
  });

  it("encloses exactly 3 sides (back, left, right) leaving the front open", () => {
    const result = phoneBooth("ph", boothRect);
    // back + left + right are all kind "wall" - 3 total, no wall on the open front.
    expect(result.furniture.filter((f) => f.kind === "wall")).toHaveLength(3);
  });

  it("registers a focus zone with capacity 1", () => {
    const result = phoneBooth("ph", boothRect);
    expect(result.zones).toHaveLength(1);
    expect(result.zones[0]).toMatchObject({ kind: "focus", capacity: 1 });
  });
});

describe("roundTable", () => {
  const rect: TileRect = { col: 0, row: 0, cols: 4, rows: 4 };

  it("produces one circular table (width === height) and seatCount chairs", () => {
    const result = roundTable("rt", rect, { label: "Reception", seatCount: 6 });
    const table = result.furniture.find((f) => f.kind === "table")!;
    expect(table.width).toBe(table.height); // square + max radius = FloorView renders a true circle
    expect(result.furniture.filter((f) => f.kind === "chair")).toHaveLength(6);
    expect(result.seats).toHaveLength(6);
  });

  it("every chair faces the table's own centre", () => {
    const result = roundTable("rt", rect, { label: "Cabin", seatCount: 5 });
    const table = result.furniture.find((f) => f.kind === "table")!;
    const centre = { x: table.x + table.width / 2, y: table.y + table.height / 2 };
    for (const chairPiece of result.furniture.filter((f) => f.kind === "chair")) {
      const chairCentre = { x: chairPiece.x + chairPiece.width / 2, y: chairPiece.y + chairPiece.height / 2 };
      const expected = Math.atan2(centre.y - chairCentre.y, centre.x - chairCentre.x);
      expect(chairPiece.rotation).toBeCloseTo(expected, 10);
    }
  });

  it("chairs never overlap the table or each other", () => {
    const result = roundTable("rt", rect, { label: "X", seatCount: 8 });
    const pieces = result.furniture;
    for (let i = 0; i < pieces.length; i++) {
      for (let j = i + 1; j < pieces.length; j++) {
        expect(furniturePiecesOverlap(pieces[i]!, pieces[j]!)).toBe(false);
      }
    }
  });

  it("defaults to a meeting zone, but accepts an explicit zoneKind override", () => {
    const meeting = roundTable("rt", rect, { label: "X", seatCount: 4 });
    expect(meeting.zones[0]!.kind).toBe("meeting");
    const open = roundTable("rt", rect, { label: "X", seatCount: 4, zoneKind: "open" });
    expect(open.zones[0]!.kind).toBe("open");
  });
});

describe("roundLounge", () => {
  const rect: TileRect = { col: 0, row: 0, cols: 8, rows: 8 };

  it("produces segments*seatsPerSegment seats and one sofa per segment", () => {
    const result = roundLounge("rl", rect, { segments: 6, seatsPerSegment: 2 });
    expect(result.seats).toHaveLength(12);
    expect(result.furniture.filter((f) => f.kind === "sofa")).toHaveLength(6);
  });

  it("never places a separate chair - seats sit on the sofa, same as benchRows", () => {
    const result = roundLounge("rl", rect, { segments: 6, seatsPerSegment: 2 });
    expect(result.furniture.filter((f) => f.kind === "chair")).toHaveLength(0);
  });

  it("no two sofa segments overlap even though the ring rotates each one", () => {
    const result = roundLounge("rl", rect, { segments: 6, seatsPerSegment: 2 });
    const sofas = result.furniture.filter((f) => f.kind === "sofa");
    for (let i = 0; i < sofas.length; i++) {
      for (let j = i + 1; j < sofas.length; j++) {
        expect(furniturePiecesOverlap(sofas[i]!, sofas[j]!)).toBe(false);
      }
    }
  });

  it("every seat sits closer to the ring centre than its own sofa's centre (faces inward)", () => {
    const result = roundLounge("rl", rect, { segments: 6, seatsPerSegment: 1 });
    const box = { x: 0, y: 0, w: 8 * 160, h: 8 * 160 };
    const centre = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const distTo = (p: { x: number; y: number }) => Math.hypot(p.x - centre.x, p.y - centre.y);
    for (let i = 0; i < result.seats.length; i++) {
      const sofa = result.furniture.filter((f) => f.kind === "sofa")[i]!;
      const sofaCentre = { x: sofa.x + sofa.width / 2, y: sofa.y + sofa.height / 2 };
      expect(distTo(result.seats[i]!.anchor)).toBeLessThan(distTo(sofaCentre));
    }
  });
});

describe("benchTable", () => {
  it("produces a square table with exactly 4 chairs, one per side", () => {
    const result = benchTable("bench", { col: 0, row: 0, cols: 2, rows: 2 }, "Bench X");
    const table = result.furniture.find((f) => f.kind === "table");
    expect(table).toBeDefined();
    expect(table!.width).toBe(table!.height); // square, never a rectangle
    expect(result.seats).toHaveLength(4);
    expect(result.zones).toHaveLength(1);
    expect(result.zones[0]!.capacity).toBe(4);
  });

  it("all four seats share one zone", () => {
    const result = benchTable("bench", { col: 0, row: 0, cols: 2, rows: 2 }, "Bench X");
    const zoneIds = new Set(result.seats.map((s) => s.zoneId));
    expect(zoneIds.size).toBe(1);
  });
});

describe("privateCabin", () => {
  it("always seats exactly 2, on a square desk", () => {
    const result = privateCabin("cabin", { col: 0, row: 0, cols: 2, rows: 2 }, { label: "Cabin 1" });
    expect(result.seats).toHaveLength(2);
    const desk = result.furniture.find((f) => f.kind === "desk");
    expect(desk!.width).toBe(desk!.height);
    expect(result.zones[0]!.kind).toBe("cabin");
    expect(result.zones[0]!.capacity).toBe(2);
  });
});

describe("allHands", () => {
  it("produces rows*cols audience seats and a separate stage with none", () => {
    const result = allHands("ah", { col: 0, row: 0, cols: 10, rows: 6 }, { rows: 4, cols: 10 });
    expect(result.seats).toHaveLength(40);

    const stage = result.zones.find((z) => z.kind === "stage");
    const audience = result.zones.find((z) => z.kind === "audience");
    expect(stage).toBeDefined();
    expect(audience?.stageId).toBe(stage!.id);
    expect(audience?.capacity).toBe(40);

    // No seat belongs to the stage zone — the presenter stands, doesn't sit.
    expect(result.seats.every((s) => s.zoneId !== stage!.id)).toBe(true);
  });
});

describe("benchRows", () => {
  const bigRect: TileRect = { col: 0, row: 0, cols: 10, rows: 6 };

  it("produces rows*seatsPerRow seats, one bench per row, and the same stage as allHands", () => {
    const result = benchRows("aud", bigRect, { rows: 4, seatsPerRow: 6 });
    expect(result.seats).toHaveLength(24);
    expect(result.furniture.filter((f) => f.kind === "table")).toHaveLength(4); // one bench per row
    expect(result.furniture.filter((f) => f.kind === "stage")).toHaveLength(1); // the stage-riser piece
    expect(result.furniture.filter((f) => f.kind === "screen")).toHaveLength(1);
    expect(result.furniture.filter((f) => f.kind === "plant")).toHaveLength(2);
  });

  it("never places a separate chair FurniturePiece - seats sit directly on the bench", () => {
    const result = benchRows("aud", bigRect, { rows: 4, seatsPerRow: 6 });
    expect(result.furniture.filter((f) => f.kind === "chair")).toHaveLength(0);
  });

  it("every seat's anchor lies on its row's bench (same y, x within the bench's span)", () => {
    const result = benchRows("aud", bigRect, { rows: 4, seatsPerRow: 6 });
    const benches = result.furniture.filter((f) => f.kind === "table");
    for (const seat of result.seats) {
      const bench = benches.find((b) => Math.abs(seat.anchor.y - (b.y + b.height / 2)) < 0.001);
      expect(bench).toBeDefined();
      expect(seat.anchor.x).toBeGreaterThanOrEqual(bench!.x);
      expect(seat.anchor.x).toBeLessThanOrEqual(bench!.x + bench!.width);
    }
  });

  it("stage and audience zones match the same structure as allHands (capacity, stageId link)", () => {
    const result = benchRows("aud", bigRect, { rows: 4, seatsPerRow: 6 });
    const stage = result.zones.find((z) => z.kind === "stage");
    const audience = result.zones.find((z) => z.kind === "audience");
    expect(stage).toBeDefined();
    expect(audience?.stageId).toBe(stage!.id);
    expect(audience?.capacity).toBe(24);
    expect(result.seats.every((s) => s.zoneId !== stage!.id)).toBe(true);
  });

  it("places one divider between each pair of neighbouring seats per row, none at the row's outer edge", () => {
    const result = benchRows("aud", bigRect, { rows: 4, seatsPerRow: 6 });
    // 5 dividers between 6 seats, per row x 4 rows.
    expect(result.furniture.filter((f) => f.kind === "wall")).toHaveLength(5 * 4);
  });
});
