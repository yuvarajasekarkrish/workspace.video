import { describe, it, expect } from "vitest";
import { openOffice1, spatialMap1, DEFAULT_MOVEMENT_CONFIG, movementConfigForLayout } from "@workspace-video/shared";
import { parseHarnessOptions, seatTargetCount } from "../loadHarnessOptions";

// What the load test runs on: which layout, and how many of the people sit. With nothing set
// it must do exactly what it did before (the old office, half the people seated), so past
// results stay comparable.

describe("parseHarnessOptions", () => {
  it("defaults to the old office with half the people seated, as before", () => {
    const options = parseHarnessOptions({});
    expect(options.layout).toBe(openOffice1);
    expect(options.seatedFraction).toBe(0.5);
    expect(options.movement).toEqual(movementConfigForLayout(openOffice1, DEFAULT_MOVEMENT_CONFIG));
  });

  it("runs on the spatial map when asked, with the walking limits of its own floor", () => {
    const options = parseHarnessOptions({ LOAD_HARNESS_LAYOUT_ID: "spatialMap@1" });
    expect(options.layout).toBe(spatialMap1);
    expect(options.movement.roomWidthPx).toBe(spatialMap1.floor.cols * 160);
    expect(options.movement.roomHeightPx).toBe(spatialMap1.floor.rows * 160);
  });

  it("refuses an unknown layout name and lists the known ones, instead of silently using another", () => {
    expect(() => parseHarnessOptions({ LOAD_HARNESS_LAYOUT_ID: "nope@1" })).toThrow(/unknown layout "nope@1".*openOffice@1.*spatialMap@1/i);
  });

  it("reads the seated fraction, and refuses anything that is not a number from 0 to 1", () => {
    expect(parseHarnessOptions({ LOAD_HARNESS_SEATED_FRACTION: "0.9" }).seatedFraction).toBe(0.9);
    expect(parseHarnessOptions({ LOAD_HARNESS_SEATED_FRACTION: "0" }).seatedFraction).toBe(0);
    for (const bad of ["abc", "-0.1", "1.5", ""]) {
      expect(() => parseHarnessOptions({ LOAD_HARNESS_SEATED_FRACTION: bad }), bad).toThrow(/between 0 and 1/i);
    }
  });
});

describe("seatTargetCount", () => {
  it("is half of n by default, the same number the test used before", () => {
    for (const n of [50, 51, 100, 200]) expect(seatTargetCount(n, n, 175, 0.5)).toBe(Math.floor(n / 2));
  });

  it("seats nine in ten when asked, but never more than there are people or seats", () => {
    expect(seatTargetCount(100, 97, 105, 0.9)).toBe(90);
    expect(seatTargetCount(100, 97, 40, 0.9)).toBe(40);
    expect(seatTargetCount(100, 10, 105, 0.9)).toBe(10);
    expect(seatTargetCount(100, 97, 105, 0)).toBe(0);
  });
});
