import { describe, it, expect } from "vitest";
import { stepToward, summarizeSeatAcks } from "../loadHarnessSeating";
import { parseHarnessOptions } from "../loadHarnessOptions";

// The server only seats someone standing within 120 px of the seat (out_of_range otherwise).
// So the load test can walk each person to their seat first, and it counts what the server answered.

describe("stepToward", () => {
  it("moves at most one step along the straight line to the target", () => {
    expect(stepToward({ x: 0, y: 0 }, { x: 300, y: 400 }, 100)).toEqual({ x: 60, y: 80 });
  });

  it("lands exactly on the target when it is within one step, and never overshoots", () => {
    expect(stepToward({ x: 0, y: 0 }, { x: 30, y: 40 }, 100)).toEqual({ x: 30, y: 40 });
    expect(stepToward({ x: 5, y: 5 }, { x: 5, y: 5 }, 100)).toEqual({ x: 5, y: 5 });
  });

  it("reaches any target in a bounded number of steps", () => {
    let p = { x: 0, y: 0 };
    let steps = 0;
    while (Math.hypot(2400 - p.x, 1500 - p.y) > 0 && steps < 1000) {
      p = stepToward(p, { x: 2400, y: 1500 }, 75);
      steps++;
    }
    expect(p).toEqual({ x: 2400, y: 1500 });
    expect(steps).toBe(Math.ceil(Math.hypot(2400, 1500) / 75));
  });
});

describe("summarizeSeatAcks", () => {
  it("counts accepted claims and each reason the server gave for refusing the others", () => {
    const summary = summarizeSeatAcks([{ ok: true }, { ok: true }, { error: "out_of_range" }, { error: "out_of_range" }, { error: "occupied" }]);
    expect(summary).toEqual({ attempted: 5, accepted: 2, refused: { out_of_range: 2, occupied: 1 } });
  });

  it("counts a missing or unreadable reply as its own kind, so nothing is silently dropped", () => {
    const summary = summarizeSeatAcks([undefined, null, "x", {}]);
    expect(summary).toEqual({ attempted: 4, accepted: 0, refused: { no_reply: 4 } });
  });

  it("is empty for no claims", () => {
    expect(summarizeSeatAcks([])).toEqual({ attempted: 0, accepted: 0, refused: {} });
  });
});

describe("parseHarnessOptions: walking to the seat", () => {
  it("is off by default, so past results stay comparable, and on with LOAD_HARNESS_WALK_TO_SEAT=1", () => {
    expect(parseHarnessOptions({}).walkToSeat).toBe(false);
    expect(parseHarnessOptions({ LOAD_HARNESS_WALK_TO_SEAT: "0" }).walkToSeat).toBe(false);
    expect(parseHarnessOptions({ LOAD_HARNESS_WALK_TO_SEAT: "1" }).walkToSeat).toBe(true);
  });
});
