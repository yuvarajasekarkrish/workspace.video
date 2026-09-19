import { describe, it, expect } from "vitest";
import { EmitTailRecorder, TAIL_THRESHOLDS_MS } from "../emitTailRecorder.js";

/** A clock the test steps by hand: each call to time() reads it twice
 *  (start, end), so the emit callback advances it by the duration under test. */
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

function timeOne(rec: EmitTailRecorder, clock: ReturnType<typeof fakeClock>, ms: number, event = "e", path: "room" | "direct" = "room") {
  rec.time(event, path, () => clock.advance(ms));
}

describe("EmitTailRecorder", () => {
  it("buckets at the exact threshold edges", () => {
    const clock = fakeClock();
    const rec = new EmitTailRecorder(clock.now);
    for (const ms of [4.99, 5, 10, 20, 40, 50]) timeOne(rec, clock, ms);
    const { overall } = rec.snapshot();
    expect(TAIL_THRESHOLDS_MS).toEqual([5, 10, 20, 40, 50]);
    expect(overall.count).toBe(6);
    // >=5: five ops; >=10: four; >=20: three; >=40: two; >=50: one.
    expect(overall.atLeast).toEqual([5, 4, 3, 2, 1]);
    expect(overall.maxMs).toBe(50);
  });

  it("keeps separate counters per path and event", () => {
    const clock = fakeClock();
    const rec = new EmitTailRecorder(clock.now);
    timeOne(rec, clock, 1, "peers:delta", "room");
    timeOne(rec, clock, 1, "peers:delta", "direct");
    timeOne(rec, clock, 1, "peers:snapshot", "direct");
    const { byKey } = rec.snapshot();
    expect(Object.keys(byKey).sort()).toEqual(["direct|peers:delta", "direct|peers:snapshot", "room|peers:delta"]);
    expect(byKey["direct|peers:snapshot"]!.count).toBe(1);
  });

  it("only ops at or above the first threshold enter the ring, and it stays bounded", () => {
    const clock = fakeClock();
    const rec = new EmitTailRecorder(clock.now);
    timeOne(rec, clock, 1);
    expect(rec.snapshot().ops).toHaveLength(0);
    for (let i = 0; i < EmitTailRecorder.MAX_OPS + 25; i++) timeOne(rec, clock, 6);
    const { ops, overall } = rec.snapshot();
    expect(ops).toHaveLength(EmitTailRecorder.MAX_OPS);
    // The exact counter is not bounded even though the ring is.
    expect(overall.count).toBe(1 + EmitTailRecorder.MAX_OPS + 25);
  });

  it("records recipients and payload size only for a slow op", () => {
    const clock = fakeClock();
    const rec = new EmitTailRecorder(clock.now);
    let lookups = 0;
    const detail = { recipients: () => (lookups++, 100), payload: { a: 1 } };
    rec.time("fast", "direct", () => clock.advance(1), detail);
    expect(lookups).toBe(0);
    rec.time("slow", "direct", () => clock.advance(8), detail);
    expect(lookups).toBe(1);
    expect(rec.snapshot().ops[0]).toMatchObject({ event: "slow", path: "direct", recipients: 100, payloadBytes: 7 });
  });

  it("still records the op when the recipient or payload lookup throws", () => {
    const clock = fakeClock();
    const rec = new EmitTailRecorder(clock.now);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    rec.time("slow", "direct", () => clock.advance(8), {
      recipients: () => {
        throw new Error("no adapter");
      },
      payload: circular,
    });
    expect(rec.snapshot().ops[0]).toMatchObject({ event: "slow", recipients: null, payloadBytes: null });
  });

  it("times an emit that throws, then rethrows the same error unchanged", () => {
    const clock = fakeClock();
    const rec = new EmitTailRecorder(clock.now);
    const boom = new Error("socket write failed");
    expect(() =>
      rec.time("e", "room", () => {
        clock.advance(12);
        throw boom;
      }),
    ).toThrow(boom);
    const { overall, ops } = rec.snapshot();
    expect(overall.count).toBe(1);
    expect(ops[0]!.durationMs).toBe(12);
  });

  it("promotes a room emit to the tick path inside a tick and sums the tick's emits", () => {
    const clock = fakeClock();
    const rec = new EmitTailRecorder(clock.now);
    timeOne(rec, clock, 2, "leave", "room"); // outside a tick
    rec.beginTick();
    timeOne(rec, clock, 3, "proximity:update", "room");
    timeOne(rec, clock, 6, "proximity:update", "room");
    timeOne(rec, clock, 4, "peers:snapshot", "direct"); // direct emits never count toward the tick
    const tick = rec.endTick();
    expect(tick).toEqual({ emitCount: 2, emitMs: 9 });
    const snap = rec.snapshot();
    expect(Object.keys(snap.byKey).sort()).toEqual(["direct|peers:snapshot", "room|leave", "tick|proximity:update"]);
    // The slow tick op knows how many emits preceded it in that tick.
    expect(snap.ops.find((o) => o.durationMs === 6)!.emitsInTickSoFar).toBe(2);
    expect(rec.endTick()).toEqual({ emitCount: 0, emitMs: 0 });
  });
});
