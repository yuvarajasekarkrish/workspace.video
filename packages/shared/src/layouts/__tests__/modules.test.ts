import { describe, it, expect } from "vitest";
import { deskPod, deskGrid, benchTable, privateCabin, allHands } from "../modules";
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
