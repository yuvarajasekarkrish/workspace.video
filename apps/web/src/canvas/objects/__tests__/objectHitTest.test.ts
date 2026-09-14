import { describe, it, expect } from "vitest";
import {
  hitTestObjects,
  hitTestResizeHandle,
  handlePosition,
  applyResize,
  type HitTestableObject,
} from "../objectHitTest";

describe("hitTestObjects", () => {
  const objects: HitTestableObject[] = [
    { objectId: "a", x: 0, y: 0, width: 100, height: 100, z: 0 },
    { objectId: "b", x: 50, y: 50, width: 100, height: 100, z: 1 },
  ];

  it("returns null when the point misses every object", () => {
    expect(hitTestObjects(objects, { x: 500, y: 500 })).toBeNull();
  });

  it("returns the only object containing the point", () => {
    expect(hitTestObjects(objects, { x: 10, y: 10 })).toBe("a");
  });

  it("returns the topmost (highest z) object where two overlap", () => {
    expect(hitTestObjects(objects, { x: 75, y: 75 })).toBe("b");
  });

  it("treats bounds as inclusive at the edges", () => {
    expect(hitTestObjects(objects, { x: 0, y: 0 })).toBe("a");
    expect(hitTestObjects(objects, { x: 100, y: 100 })).toBe("b"); // higher z wins the corner tie
  });

  it("returns an empty-array miss as null", () => {
    expect(hitTestObjects([], { x: 0, y: 0 })).toBeNull();
  });
});

describe("handlePosition", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 50 };

  it("places corner handles exactly at the corners", () => {
    expect(handlePosition(bounds, "nw")).toEqual({ x: 0, y: 0 });
    expect(handlePosition(bounds, "se")).toEqual({ x: 100, y: 50 });
  });

  it("places edge handles at the midpoint of their edge", () => {
    expect(handlePosition(bounds, "n")).toEqual({ x: 50, y: 0 });
    expect(handlePosition(bounds, "e")).toEqual({ x: 100, y: 25 });
  });
});

describe("hitTestResizeHandle", () => {
  const bounds = { x: 0, y: 0, width: 100, height: 100 };

  it("detects a point exactly on a corner handle", () => {
    expect(hitTestResizeHandle(bounds, { x: 0, y: 0 }, 1)).toBe("nw");
  });

  it("returns null for a point far from every handle", () => {
    expect(hitTestResizeHandle(bounds, { x: 50, y: 50 }, 1)).toBeNull();
  });

  it("shrinks the hit radius in world space as zoom increases (handle size stays constant on screen)", () => {
    // At scale 1, an 8px handle has a 4px world radius — 3px away hits.
    expect(hitTestResizeHandle(bounds, { x: 3, y: 0 }, 1, 8)).toBe("nw");
    // At scale 4, that same 8 SCREEN px is only 1px in world space — 3px away misses.
    expect(hitTestResizeHandle(bounds, { x: 3, y: 0 }, 4, 8)).toBeNull();
  });
});

describe("applyResize", () => {
  const original = { x: 100, y: 100, width: 200, height: 100 };

  it("se handle grows width/height without moving x/y", () => {
    const result = applyResize(original, "se", { x: 50, y: 20 });
    expect(result).toEqual({ x: 100, y: 100, width: 250, height: 120 });
  });

  it("nw handle moves x/y and shrinks width/height inversely, keeping the opposite corner fixed", () => {
    const result = applyResize(original, "nw", { x: 20, y: 10 });
    expect(result.x).toBe(120);
    expect(result.y).toBe(110);
    expect(result.width).toBe(180);
    expect(result.height).toBe(90);
    // The bottom-right corner must be unchanged.
    expect(result.x + result.width).toBe(original.x + original.width);
    expect(result.y + result.height).toBe(original.y + original.height);
  });

  it("e handle only changes width", () => {
    const result = applyResize(original, "e", { x: 30, y: 999 });
    expect(result).toEqual({ x: 100, y: 100, width: 230, height: 100 });
  });

  it("n handle only changes y and height, anchoring the bottom edge", () => {
    const result = applyResize(original, "n", { x: 999, y: 30 });
    expect(result.x).toBe(100);
    expect(result.width).toBe(200);
    expect(result.y).toBe(130);
    expect(result.height).toBe(70);
  });

  it("never shrinks below minSize", () => {
    const result = applyResize(original, "e", { x: -10_000, y: 0 }, 20);
    expect(result.width).toBe(20);
  });

  it("never shrinks below minSize from the opposite-edge-anchored side either", () => {
    const result = applyResize(original, "w", { x: 10_000, y: 0 }, 20);
    expect(result.width).toBe(20);
    // The right edge stays anchored even once clamped.
    expect(result.x + result.width).toBe(original.x + original.width);
  });
});
