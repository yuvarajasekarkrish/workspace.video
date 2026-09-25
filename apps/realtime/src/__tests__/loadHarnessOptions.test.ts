import { describe, it, expect } from "vitest";
import { DEFAULT_LAYOUT_ID, resolveLayout, DEFAULT_MOVEMENT_CONFIG, movementConfigForLayout } from "@workspace-video/shared";
import { parseHarnessOptions, seatTargetCount } from "../loadHarnessOptions";

// What the load test runs on: which layout, and how many of the people sit. With nothing set
// it must match whatever the app's own default layout is (registry.ts's DEFAULT_LAYOUT_ID) —
// a real user gets the default with no config either, so the harness's "nothing set" case
// should exercise the same layout, not a fixed one that could silently drift from reality.
// Half the people seated stays fixed regardless of which layout is the default.

describe("parseHarnessOptions", () => {
  it("defaults to the app's own default layout with half the people seated", () => {
    const defaultLayout = resolveLayout(DEFAULT_LAYOUT_ID)!;
    const options = parseHarnessOptions({});
    expect(options.layout).toBe(defaultLayout);
    expect(options.seatedFraction).toBe(0.5);
    expect(options.movement).toEqual(movementConfigForLayout(defaultLayout, DEFAULT_MOVEMENT_CONFIG));
  });

  it("runs on a named layout when asked, with the walking limits of its own floor", () => {
    const layout = resolveLayout("office300@1")!;
    const options = parseHarnessOptions({ LOAD_HARNESS_LAYOUT_ID: "office300@1" });
    expect(options.layout).toBe(layout);
    expect(options.movement.roomWidthPx).toBe(layout.floor.cols * 160);
    expect(options.movement.roomHeightPx).toBe(layout.floor.rows * 160);
  });

  it("refuses an unknown layout name and lists the known ones, instead of silently using another", () => {
    expect(() => parseHarnessOptions({ LOAD_HARNESS_LAYOUT_ID: "nope@1" })).toThrow(/unknown layout "nope@1".*office300@1/i);
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
