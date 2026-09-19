import { describe, it, expect, vi } from "vitest";
import { constants } from "node:perf_hooks";
import { GcRecorder, startGcObserver } from "../gcRecorder.js";

describe("GcRecorder", () => {
  it("maps both the modern detail.kind and the legacy kind field", () => {
    const rec = new GcRecorder();
    rec.record({ startTime: 1, duration: 30, detail: { kind: constants.NODE_PERFORMANCE_GC_MAJOR } });
    rec.record({ startTime: 2, duration: 1, kind: constants.NODE_PERFORMANCE_GC_MINOR });
    rec.record({ startTime: 3, duration: 2, detail: { kind: 999 } });
    const snap = rec.snapshot();
    expect(Object.keys(snap.byKind).sort()).toEqual(["major", "minor", "unknown"]);
    expect(snap.byKind.major!.atLeast).toEqual([1, 1, 1, 0, 0]);
    expect(snap.overall.count).toBe(3);
  });

  it("keeps only pauses at or above 5ms in the ring, stamped with their start time", () => {
    const rec = new GcRecorder();
    rec.record({ startTime: 100, duration: 1, detail: { kind: constants.NODE_PERFORMANCE_GC_MINOR } });
    rec.record({ startTime: 200, duration: 42, detail: { kind: constants.NODE_PERFORMANCE_GC_MAJOR } });
    expect(rec.snapshot().pauses).toEqual([{ atMs: 200, durationMs: 42, kind: "major" }]);
  });

  it("bounds the ring", () => {
    const rec = new GcRecorder();
    for (let i = 0; i < GcRecorder.MAX_PAUSES + 10; i++) {
      rec.record({ startTime: i, duration: 6, detail: { kind: constants.NODE_PERFORMANCE_GC_MAJOR } });
    }
    expect(rec.snapshot().pauses).toHaveLength(GcRecorder.MAX_PAUSES);
  });

  it("never throws on a malformed entry", () => {
    const rec = new GcRecorder();
    expect(() => rec.record(null as never)).not.toThrow();
  });
});

describe("startGcObserver", () => {
  it("feeds entries to the recorder and disconnects on stop", () => {
    const disconnect = vi.fn();
    let deliver: ((list: { getEntries(): unknown[] }) => void) | undefined;
    class FakeObserver {
      constructor(cb: (list: { getEntries(): unknown[] }) => void) {
        deliver = cb;
      }
      observe = vi.fn();
      disconnect = disconnect;
    }
    const rec = new GcRecorder();
    const stop = startGcObserver(rec, FakeObserver as never);
    expect(rec.supported).toBe(true);
    deliver!({ getEntries: () => [{ startTime: 5, duration: 9, detail: { kind: constants.NODE_PERFORMANCE_GC_MAJOR } }] });
    expect(rec.snapshot().overall.count).toBe(1);
    stop();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("degrades to unsupported, without throwing, when the runtime cannot observe GC", () => {
    class Broken {
      constructor() {
        throw new Error("gc entry type not supported");
      }
    }
    const rec = new GcRecorder();
    const stop = startGcObserver(rec, Broken as never);
    expect(rec.supported).toBe(false);
    expect(() => stop()).not.toThrow();
  });
});
