import { describe, it, expect } from "vitest";
import {
  exceedsDragThreshold,
  clampZoom,
  screenToWorld,
  computeCursorAnchoredZoom,
  MIN_ZOOM,
  MAX_ZOOM,
} from "../viewportMath";

describe("exceedsDragThreshold", () => {
  it("is false for a press-and-release with no movement", () => {
    expect(exceedsDragThreshold({ x: 100, y: 100 }, { x: 100, y: 100 })).toBe(false);
  });

  it("is false just under the threshold", () => {
    expect(exceedsDragThreshold({ x: 0, y: 0 }, { x: 4, y: 0 })).toBe(false);
  });

  it("is true just over the threshold", () => {
    expect(exceedsDragThreshold({ x: 0, y: 0 }, { x: 6, y: 0 })).toBe(true);
  });
});

describe("clampZoom", () => {
  it("passes through an in-range zoom unchanged", () => {
    expect(clampZoom(1.5)).toBe(1.5);
  });

  it("clamps below the minimum", () => {
    expect(clampZoom(0.01)).toBe(MIN_ZOOM);
  });

  it("clamps above the maximum", () => {
    expect(clampZoom(50)).toBe(MAX_ZOOM);
  });
});

describe("screenToWorld", () => {
  it("maps origin correctly with no pan/zoom", () => {
    expect(screenToWorld({ x: 50, y: 50 }, { x: 0, y: 0 }, 1)).toEqual({ x: 50, y: 50 });
  });

  it("accounts for pan offset", () => {
    expect(screenToWorld({ x: 50, y: 50 }, { x: 20, y: 10 }, 1)).toEqual({ x: 30, y: 40 });
  });

  it("accounts for scale", () => {
    expect(screenToWorld({ x: 100, y: 100 }, { x: 0, y: 0 }, 2)).toEqual({ x: 50, y: 50 });
  });
});

describe("computeCursorAnchoredZoom", () => {
  it("keeps the world point under the cursor fixed after zooming in", () => {
    const cursor = { x: 400, y: 300 };
    const worldPosition = { x: 0, y: 0 };
    const currentScale = 1;

    const before = screenToWorld(cursor, worldPosition, currentScale);
    const { scale, position } = computeCursorAnchoredZoom(cursor, worldPosition, currentScale, 1.5);
    const after = screenToWorld(cursor, position, scale);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it("clamps the resulting scale to the maximum", () => {
    const { scale } = computeCursorAnchoredZoom({ x: 0, y: 0 }, { x: 0, y: 0 }, MAX_ZOOM, 2);
    expect(scale).toBe(MAX_ZOOM);
  });

  it("clamps the resulting scale to the minimum", () => {
    const { scale } = computeCursorAnchoredZoom({ x: 0, y: 0 }, { x: 0, y: 0 }, MIN_ZOOM, 0.1);
    expect(scale).toBe(MIN_ZOOM);
  });

  it("still anchors correctly even when the result is clamped", () => {
    const cursor = { x: 200, y: 150 };
    const worldPosition = { x: 10, y: 10 };
    const currentScale = MAX_ZOOM;

    const before = screenToWorld(cursor, worldPosition, currentScale);
    const { scale, position } = computeCursorAnchoredZoom(cursor, worldPosition, currentScale, 3);
    expect(scale).toBe(MAX_ZOOM); // already at max, factor > 1 clamps to same value
    const after = screenToWorld(cursor, position, scale);

    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
});
