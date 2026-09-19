import { describe, it, expect } from "vitest";
import { summarizeStalls, summarizeStallsCovered, type StallWindow } from "../stallSummary.js";

// A window ends at atMs and spans windowMs before it: [atMs - windowMs, atMs].
const win = (atMs: number, loopMaxMs: number, extra: Partial<StallWindow> = {}): StallWindow => ({
  atMs,
  windowMs: 100,
  loopMaxMs,
  tickMs: 15,
  ...extra,
});

describe("summarizeStalls", () => {
  it("splits windows into stalled and control by loopMaxMs", () => {
    const s = summarizeStalls([win(1000, 60), win(1100, 10), win(1200, 50), win(1300, 49.9)], [], []);
    expect(s.stalled.windows).toBe(2); // 60 and exactly 50
    expect(s.control.windows).toBe(2);
  });

  it("counts an emit that is contained in, spans, or just touches a window", () => {
    const stalled = win(1000, 60); // spans [900, 1000]
    const contained = { atMs: 950, durationMs: 25 };
    const spanning = { atMs: 850, durationMs: 200 };
    const touchingStart = { atMs: 860, durationMs: 40 }; // ends exactly at 900
    const touchingEnd = { atMs: 1000, durationMs: 25 }; // starts exactly at 1000
    for (const span of [contained, spanning, touchingStart, touchingEnd]) {
      expect(summarizeStalls([stalled], [span], []).stalled.withEmit).toBe(1);
    }
  });

  it("does not count an op wholly before or after the window", () => {
    const stalled = win(1000, 60);
    const before = { atMs: 800, durationMs: 50 }; // ends at 850
    const after = { atMs: 1001, durationMs: 50 };
    const s = summarizeStalls([stalled], [before, after], []);
    expect(s.stalled.withEmit).toBe(0);
    expect(s.stalled.withNeither).toBe(1);
  });

  it("ignores ops below the overlap threshold", () => {
    const s = summarizeStalls([win(1000, 60)], [{ atMs: 950, durationMs: 19.9 }], [{ atMs: 950, durationMs: 19.9 }]);
    expect(s.stalled.withNeither).toBe(1);
  });

  it("reports emit, gc, both and neither separately", () => {
    const windows = [win(1000, 60), win(1100, 60), win(1200, 60), win(1300, 60)];
    const emits = [{ atMs: 950, durationMs: 30 }, { atMs: 1050, durationMs: 30 }];
    const gcs = [{ atMs: 1060, durationMs: 30 }, { atMs: 1150, durationMs: 30 }];
    const s = summarizeStalls(windows, emits, gcs).stalled;
    expect(s).toMatchObject({ windows: 4, withEmit: 2, withGc: 2, withBoth: 1, withNeither: 1 });
  });

  it("gives the control group the same counts, as the chance baseline", () => {
    const s = summarizeStalls([win(1000, 60), win(1100, 5)], [{ atMs: 1050, durationMs: 30 }], []);
    expect(s.stalled.withEmit).toBe(0);
    expect(s.control.withEmit).toBe(1);
  });

  it("reports medians of tick and emit time, and handles empty input", () => {
    const s = summarizeStalls([win(1000, 60, { tickMs: 20, emitMs: 8 }), win(1100, 60, { tickMs: 30, emitMs: 12 })], [], []);
    expect(s.stalled.medianTickMs).toBe(30);
    expect(s.stalled.medianEmitMs).toBe(12);
    const empty = summarizeStalls([], [], []);
    expect(empty.stalled).toMatchObject({ windows: 0, medianTickMs: null, medianEmitMs: null });
  });

  it("analyzes every window when no ring is full", () => {
    const windows = [win(1000, 60), win(1100, 5)];
    const s = summarizeStallsCovered(windows, [{ atMs: 1050, durationMs: 30 }], [], { ops: 200, pauses: 100 });
    expect(s).toMatchObject({ totalWindows: 2, analyzedWindows: 2, truncated: false });
  });

  it("drops windows that start before a FULL ring's oldest entry, so absence is not misread", () => {
    // Ring of 2 is full and its oldest op is at 1500: windows before that
    // cannot be judged "no slow emit".
    const windows = [win(1000, 60), win(1400, 60), win(1600, 60)];
    const ops = [{ atMs: 1500, durationMs: 30 }, { atMs: 1590, durationMs: 30 }];
    const s = summarizeStallsCovered(windows, ops, [], { ops: 2, pauses: 100 });
    expect(s).toMatchObject({ totalWindows: 3, analyzedWindows: 1, truncated: true });
    expect(s.stalled.windows).toBe(1);
  });

  it("does not depend on the order the windows arrive in", () => {
    const windows = [win(1300, 60), win(1000, 60), win(1200, 5), win(1100, 60)];
    const emits = [{ atMs: 1050, durationMs: 30 }];
    expect(summarizeStalls(windows, emits, [])).toEqual(summarizeStalls([...windows].reverse(), emits, []));
  });
});
