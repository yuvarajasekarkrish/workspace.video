import { describe, it, expect } from "vitest";
import { furniturePiecesOverlap, findOverlappingFurniture, canPlaceFurniture } from "../collision";
import { deskGrid } from "../modules";
import type { FurniturePiece, TileRect } from "../types";

function piece(overrides: Partial<FurniturePiece> & { id: string }): FurniturePiece {
  return { kind: "desk", x: 0, y: 0, width: 20, height: 20, rotation: 0, ...overrides };
}

describe("furniturePiecesOverlap - axis-aligned", () => {
  it("detects two clearly overlapping squares", () => {
    const a = piece({ id: "a", x: 0, y: 0, width: 20, height: 20 });
    const b = piece({ id: "b", x: 10, y: 10, width: 20, height: 20 });
    expect(furniturePiecesOverlap(a, b)).toBe(true);
  });

  it("detects two clearly separated squares", () => {
    const a = piece({ id: "a", x: 0, y: 0, width: 20, height: 20 });
    const b = piece({ id: "b", x: 100, y: 100, width: 20, height: 20 });
    expect(furniturePiecesOverlap(a, b)).toBe(false);
  });

  it("does not count two pieces exactly touching edge-to-edge as overlapping", () => {
    // a spans x 0..20, b spans x 20..40 - flush side by side, a normal admin layout.
    const a = piece({ id: "a", x: 0, y: 0, width: 20, height: 20 });
    const b = piece({ id: "b", x: 20, y: 0, width: 20, height: 20 });
    expect(furniturePiecesOverlap(a, b)).toBe(false);
  });

  it("detects a 1px real overlap, not just a gross one", () => {
    const a = piece({ id: "a", x: 0, y: 0, width: 20, height: 20 });
    const b = piece({ id: "b", x: 19, y: 0, width: 20, height: 20 });
    expect(furniturePiecesOverlap(a, b)).toBe(true);
  });
});

describe("furniturePiecesOverlap - rotated", () => {
  it("detects two 45deg-rotated squares placed close enough to overlap", () => {
    // A 20x20 square rotated 45deg reaches its own centre +/-14.14px along
    // an axis-aligned direction (half-diagonal = 10*sqrt(2)). Two stacked
    // 15px apart (centre-to-centre) must overlap: 14.14 + 14.14 > 15.
    const a = piece({ id: "a", x: -10, y: -10, width: 20, height: 20, rotation: Math.PI / 4 });
    const b = piece({ id: "b", x: -10, y: 5, width: 20, height: 20, rotation: Math.PI / 4 }); // centre (0,15)
    expect(furniturePiecesOverlap(a, b)).toBe(true);
  });

  it("does not flag two 45deg-rotated squares placed far enough apart", () => {
    // 40px centre-to-centre is well beyond 14.14 + 14.14 = 28.28.
    const a = piece({ id: "a", x: -10, y: -10, width: 20, height: 20, rotation: Math.PI / 4 });
    const b = piece({ id: "b", x: -10, y: 30, width: 20, height: 20, rotation: Math.PI / 4 }); // centre (0,40)
    expect(furniturePiecesOverlap(a, b)).toBe(false);
  });

  it("ignores id and kind - pure geometry, any furniture kind", () => {
    const a = piece({ id: "chair-1", kind: "chair", x: 0, y: 0, width: 34, height: 34, rotation: 1.2 });
    const b = piece({ id: "table-1", kind: "table", x: 5, y: 5, width: 34, height: 34, rotation: -0.7 });
    expect(furniturePiecesOverlap(a, b)).toBe(true);
  });
});

describe("real production layout: deskGrid's own desks never overlap each other", () => {
  it("holds for the real 6x6 production case", () => {
    const rect: TileRect = { col: 0, row: 0, cols: 6, rows: 6 };
    const result = deskGrid("floor", rect, { cols: 6, rows: 6, startNumber: 1 });
    const desks = result.furniture.filter((f) => f.kind === "desk");
    for (let i = 0; i < desks.length; i++) {
      for (let j = i + 1; j < desks.length; j++) {
        expect(furniturePiecesOverlap(desks[i]!, desks[j]!)).toBe(false);
      }
    }
  });
});

describe("findOverlappingFurniture / canPlaceFurniture", () => {
  const existing: FurniturePiece[] = [
    piece({ id: "desk-1", x: 0, y: 0, width: 76, height: 76 }),
    piece({ id: "desk-2", x: 200, y: 0, width: 76, height: 76 }),
  ];

  it("rejects placing a new desk on top of an existing one", () => {
    const candidate = piece({ id: "desk-new", x: 20, y: 20, width: 76, height: 76 });
    const result = canPlaceFurniture(candidate, existing);
    expect(result.allowed).toBe(false);
    expect(result.collidesWith).toEqual(["desk-1"]);
  });

  it("allows placing a new desk in genuinely free space", () => {
    const candidate = piece({ id: "desk-new", x: 500, y: 500, width: 76, height: 76 });
    const result = canPlaceFurniture(candidate, existing);
    expect(result.allowed).toBe(true);
    expect(result.collidesWith).toEqual([]);
  });

  it("does not treat a piece as colliding with itself when re-checking its own current spot", () => {
    // Dragging desk-1 and dropping it back where it already is - not a collision with itself.
    const candidate = piece({ id: "desk-1", x: 0, y: 0, width: 76, height: 76 });
    const result = canPlaceFurniture(candidate, existing);
    expect(result.allowed).toBe(true);
  });

  it("lists every overlapping piece, not just the first", () => {
    const crowded: FurniturePiece[] = [
      piece({ id: "a", x: 0, y: 0, width: 40, height: 40 }),
      piece({ id: "b", x: 10, y: 10, width: 40, height: 40 }),
    ];
    const candidate = piece({ id: "new", x: 5, y: 5, width: 40, height: 40 });
    const result = findOverlappingFurniture(candidate, crowded);
    expect(result.map((p) => p.id).sort()).toEqual(["a", "b"]);
  });
});
