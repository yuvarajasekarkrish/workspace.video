import { describe, it, expect } from "vitest";
import {
  exceedsDragThreshold,
  clampZoom,
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
