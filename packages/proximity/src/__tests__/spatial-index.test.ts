import { describe, it, expect } from "vitest";
import { NaiveSpatialIndex, UniformGridIndex } from "../spatial-index";

const CELL = 525; // audioRadiusPx (500) + hysteresisPx (25)

function pairSetFromCandidates(index: { forEachCandidatePair(cb: (a: string, b: string) => void): void }): Set<string> {
  const set = new Set<string>();
  index.forEachCandidatePair((a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    expect(set.has(key)).toBe(false); // no duplicate pairs
    set.add(key);
  });
  return set;
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

describe("UniformGridIndex — insertion/removal", () => {
  it("inserts and reports positions", () => {
    const idx = new UniformGridIndex(2000, 2000, CELL);
    idx.insert("a", { x: 10, y: 20 });
    expect(idx.getPosition("a")).toEqual({ x: 10, y: 20 });
    expect(idx.allIds()).toEqual(["a"]);
  });

  it("removes an id so it no longer appears in queries or pairs", () => {
    const idx = new UniformGridIndex(2000, 2000, CELL);
    idx.insert("a", { x: 10, y: 10 });
    idx.insert("b", { x: 20, y: 20 });
    idx.remove("a");
    expect(idx.allIds()).toEqual(["b"]);
    expect(idx.getPosition("a")).toBeUndefined();
    const pairs = pairSetFromCandidates(idx);
    expect(pairs.size).toBe(0);
  });

  it("move within the same cell does not change bucket membership", () => {
    const idx = new UniformGridIndex(2000, 2000, CELL);
    idx.insert("a", { x: 10, y: 10 });
    idx.move("a", { x: 15, y: 12 });
    expect(idx.getPosition("a")).toEqual({ x: 15, y: 12 });
    expect(idx.allIds()).toEqual(["a"]);
  });

  it("move across cells keeps exactly one entry (no duplication/leak)", () => {
    const idx = new UniformGridIndex(3000, 3000, CELL);
    idx.insert("a", { x: 10, y: 10 });
    idx.move("a", { x: 2000, y: 2000 });
    expect(idx.allIds()).toEqual(["a"]);
    expect(idx.getPosition("a")).toEqual({ x: 2000, y: 2000 });
  });

  it("move() on an unindexed id behaves like insert", () => {
    const idx = new UniformGridIndex(2000, 2000, CELL);
    idx.move("a", { x: 5, y: 5 });
    expect(idx.getPosition("a")).toEqual({ x: 5, y: 5 });
  });
});

describe("UniformGridIndex — boundary cases", () => {
  it("clamps out-of-range coordinates into the edge cell instead of throwing", () => {
    const idx = new UniformGridIndex(1000, 1000, CELL);
    expect(() => idx.insert("a", { x: -50, y: 5000 })).not.toThrow();
    expect(idx.getPosition("a")).toEqual({ x: -50, y: 5000 });
  });

  it("a pair exactly at the cell size distance is still found as a candidate", () => {
    const idx = new UniformGridIndex(2000, 2000, CELL);
    idx.insert("a", { x: 0, y: 0 });
    idx.insert("b", { x: CELL, y: 0 }); // distance === CELL, likely crosses a cell boundary
    const pairs = pairSetFromCandidates(idx);
    expect(pairs.has("a:b")).toBe(true);
  });

  it("a pair straddling a cell corner (diagonal neighbour) is still found", () => {
    const idx = new UniformGridIndex(2000, 2000, CELL);
    // Just inside one cell's bottom-right corner, and just inside the
    // diagonally-adjacent cell's top-left corner.
    idx.insert("a", { x: CELL - 1, y: CELL - 1 });
    idx.insert("b", { x: CELL + 1, y: CELL + 1 });
    expect(distance({ x: CELL - 1, y: CELL - 1 }, { x: CELL + 1, y: CELL + 1 })).toBeLessThan(CELL);
    const pairs = pairSetFromCandidates(idx);
    expect(pairs.has("a:b")).toBe(true);
  });

  it("far-apart ids across many cells are not candidates", () => {
    const idx = new UniformGridIndex(10_000, 10_000, CELL);
    idx.insert("a", { x: 0, y: 0 });
    idx.insert("b", { x: 9000, y: 9000 });
    const pairs = pairSetFromCandidates(idx);
    expect(pairs.size).toBe(0);
  });
});

describe("UniformGridIndex vs NaiveSpatialIndex — fuzz equivalence", () => {
  it("candidate pairs are a superset of every truly-in-range naive pair, with no duplicates", () => {
    const width = 3000;
    const height = 3000;
    const naive = new NaiveSpatialIndex();
    const grid = new UniformGridIndex(width, height, CELL);

    const rng = mulberry32(42);
    const points: { id: string; x: number; y: number }[] = [];
    for (let i = 0; i < 150; i++) {
      const id = `u${i}`;
      const x = rng() * width;
      const y = rng() * height;
      points.push({ id, x, y });
      naive.insert(id, { x, y });
      grid.insert(id, { x, y });
    }

    const inRangeNaive = new Set<string>();
    naive.forEachCandidatePair((a, b) => {
      const pa = points.find((p) => p.id === a)!;
      const pb = points.find((p) => p.id === b)!;
      if (distance(pa, pb) <= CELL) {
        const key = a < b ? `${a}:${b}` : `${b}:${a}`;
        inRangeNaive.add(key);
      }
    });

    const gridPairs = pairSetFromCandidates(grid);

    for (const key of inRangeNaive) {
      expect(gridPairs.has(key)).toBe(true);
    }
    // Every candidate the grid proposes must actually be within the cell
    // radius of each other, or at least within one more coarse bound: the
    // grid's guarantee is "candidates ⊇ true in-range pairs", not that every
    // candidate is itself in range (a diagonal neighbour cell can hold a
    // slightly-farther point) — assert the guarantee, not over-precision.
    expect(gridPairs.size).toBeGreaterThanOrEqual(inRangeNaive.size);
  });
});

function mulberry32(seed: number): () => number {
  let a = seed;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
