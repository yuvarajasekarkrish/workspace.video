import { describe, it, expect } from "vitest";
import { validateMove } from "../movement.js";
import { DEFAULT_MOVEMENT_CONFIG } from "@workspace-video/shared";

const cfg = DEFAULT_MOVEMENT_CONFIG; // maxSpeed=2000px/s, bounds 8000x8000

describe("validateMove", () => {
  const base = { position: { x: 100, y: 100 }, acceptedAtMs: 1000 };

  it("accepts a small move within the speed limit", () => {
    const r = validateMove({ x: 105, y: 100 }, base, 1050, cfg); // 5px in 50ms = 100px/s
    expect(r.accepted).toBe(true);
  });

  it("rejects non-finite coordinates as invalid", () => {
    const r = validateMove({ x: NaN, y: 5 }, base, 1050, cfg);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe("invalid");
      expect(r.correctedPosition).toEqual(base.position);
    }
  });

  it("rejects Infinity as invalid", () => {
    const r = validateMove({ x: Infinity, y: 5 }, base, 1050, cfg);
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toBe("invalid");
  });

  it("rejects and clamps out-of-bounds coordinates", () => {
    const r = validateMove({ x: -50, y: 9000 }, base, 1050, cfg);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe("out_of_bounds");
      expect(r.correctedPosition).toEqual({ x: 0, y: cfg.roomHeightPx });
    }
  });

  it("rejects a move implying speed over the max as max_speed_exceeded", () => {
    // 5000px in 50ms = 100,000 px/s, way over 2000 px/s
    const r = validateMove({ x: 5100, y: 100 }, base, 1050, cfg);
    expect(r.accepted).toBe(false);
    if (!r.accepted) {
      expect(r.reason).toBe("max_speed_exceeded");
      expect(r.correctedPosition).toEqual(base.position);
    }
  });

  it("accepts a large move if enough time has elapsed to justify the speed", () => {
    // 1000px over 1 full second = 1000px/s, under the 2000px/s cap
    const r = validateMove({ x: 1100, y: 100 }, base, 2000, cfg);
    expect(r.accepted).toBe(true);
  });

  it("does not divide by ~zero elapsed time into a false accept", () => {
    // huge jump with (near) zero elapsed time must be rejected, not accepted
    // via an unbounded allowance.
    const r = validateMove({ x: 7900, y: 100 }, base, 1000, cfg);
    expect(r.accepted).toBe(false);
  });
});

/** Drives validateMove the way RoomManager.applyMove does: on an accept the
 *  position and acceptedAtMs advance and the returned credit is carried; on a
 *  reject nothing changes. */
function walk(moves: { atMs: number; x: number }[], start = { x: 0, atMs: 0 }) {
  let state = { position: { x: start.x, y: 0 }, acceptedAtMs: start.atMs, creditMs: 0 };
  return moves.map((m) => {
    const r = validateMove({ x: m.x, y: 0 }, state, m.atMs, cfg);
    if (r.accepted) {
      state = {
        position: r.position,
        acceptedAtMs: m.atMs,
        creditMs: (r as { nextCreditMs?: number }).nextCreditMs ?? 0,
      };
    }
    return r.accepted;
  });
}

describe("validateMove: server stalls are not charged to the user", () => {
  it("accepts two legitimate 20px moves that arrive 7ms apart after a stall", () => {
    // Emitted 50ms apart by the client; a server stall delivers them together.
    // This is the measured production failure: 20px in 7ms reads as ~2857px/s.
    expect(walk([{ atMs: 60, x: 20 }, { atMs: 67, x: 40 }])).toEqual([true, true]);
  });

  it("accepts steady 20px-per-50ms walking (400px/s) indefinitely", () => {
    const moves = Array.from({ length: 100 }, (_, i) => ({ atMs: (i + 1) * 50, x: (i + 1) * 20 }));
    expect(walk(moves).every(Boolean)).toBe(true);
  });

  it("still rejects sustained speed well over the limit (200px per 50ms = 4000px/s)", () => {
    const moves = Array.from({ length: 12 }, (_, i) => ({ atMs: (i + 1) * 50, x: (i + 1) * 200 }));
    const results = walk(moves);
    // Credit only builds from moves that were accepted, so a cheater who
    // never walks legitimately never earns any: nothing sustained gets through.
    expect(results.slice(-3)).toEqual([false, false, false]);
  });

  it("drains carried credit: after legitimate walking, 200px per 50ms is accepted only briefly", () => {
    const legit = Array.from({ length: 20 }, (_, i) => ({ atMs: (i + 1) * 50, x: (i + 1) * 20 }));
    const cheat = Array.from({ length: 12 }, (_, i) => ({ atMs: 1000 + (i + 1) * 50, x: 400 + (i + 1) * 200 }));
    const results = walk([...legit, ...cheat]).slice(legit.length);
    expect(results[0], "stored credit lets the first fast moves through").toBe(true);
    expect(results.slice(-3), "but the credit runs out").toEqual([false, false, false]);
  });

  it("caps carried credit: a 500px move 7ms after an idle-then-small move is rejected", () => {
    // Idle for a long time, one small accepted move, then a huge move almost
    // immediately. Credit is capped at maxBurstMs (200ms => (7+200)*2 = 414px).
    const results = walk([{ atMs: 10_000, x: 1 }, { atMs: 10_007, x: 501 }]);
    expect(results).toEqual([true, false]);
  });
});
