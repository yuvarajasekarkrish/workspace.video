import { describe, it, expect } from "vitest";
import { validateMove, validateTeleport } from "../movement.js";
import { DEFAULT_MOVEMENT_CONFIG } from "@workspace-video/shared";

const cfg = DEFAULT_MOVEMENT_CONFIG; // maxSpeed=2000px/s, bounds 8000x8000

describe("validateTeleport", () => {
  it("accepts a far-away in-bounds target that validateMove would reject as too fast", () => {
    const target = { x: cfg.roomWidthPx - 10, y: cfg.roomHeightPx - 10 }; // thousands of px away
    const r = validateTeleport(target, cfg);
    expect(r).toEqual({ accepted: true, position: target });

    // Prove the contrast: the same jump through the continuous-speed
    // validator, "instantly" (0ms elapsed), is rejected — this is exactly
    // why teleportTo is a separate action, not a relaxed validateMove.
    const asOrdinaryMove = validateMove(target, { position: { x: 0, y: 0 }, acceptedAtMs: 1000 }, 1000, cfg);
    expect(asOrdinaryMove.accepted).toBe(false);
  });

  it("rejects non-finite coordinates as invalid", () => {
    const r = validateTeleport({ x: NaN, y: 10 }, cfg);
    expect(r).toEqual({ accepted: false, reason: "invalid", correctedPosition: { x: 0, y: 0 } });
  });

  it("rejects and clamps a target outside room bounds", () => {
    const r = validateTeleport({ x: cfg.roomWidthPx + 500, y: -500 }, cfg);
    expect(r).toEqual({ accepted: false, reason: "out_of_bounds", correctedPosition: { x: cfg.roomWidthPx, y: 0 } });
  });

  it("accepts a target exactly on the boundary", () => {
    const r = validateTeleport({ x: 0, y: cfg.roomHeightPx }, cfg);
    expect(r).toEqual({ accepted: true, position: { x: 0, y: cfg.roomHeightPx } });
  });
});

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

describe("validateMove: rejection banks bounded credit and resyncs the timestamp", () => {
  it("a max_speed_exceeded rejection returns nextAcceptedAtMs=nowMs and nextCreditMs capped at maxBurstMs", () => {
    const previous = { position: { x: 0, y: 0 }, acceptedAtMs: 1000, creditMs: 0 };
    // 75px at nowMs=1001 (1ms elapsed) is way too fast — the exact shape of a
    // same-tick drained message.
    const r = validateMove({ x: 75, y: 0 }, previous, 1001, cfg);
    expect(r.accepted).toBe(false);
    if (r.accepted || r.reason !== "max_speed_exceeded") throw new Error("expected max_speed_exceeded");
    expect(r.correctedPosition).toEqual(previous.position); // position never advances on reject
    expect(r.nextAcceptedAtMs).toBe(1001); // bookkeeping resyncs to now
    expect(r.nextCreditMs).toBe(1); // budgetMs=1ms, well under maxBurstMs=200
  });

  it("out_of_bounds and invalid rejections carry no nextAcceptedAtMs/nextCreditMs — unchanged from before this fix", () => {
    const previous = { position: { x: 100, y: 100 }, acceptedAtMs: 1000, creditMs: 50 };
    const oob = validateMove({ x: -50, y: 100 }, previous, 1010, cfg);
    expect(oob.accepted).toBe(false);
    expect("nextAcceptedAtMs" in oob).toBe(false);
    expect("nextCreditMs" in oob).toBe(false);

    const invalid = validateMove({ x: NaN, y: 100 }, previous, 1010, cfg);
    expect(invalid.accepted).toBe(false);
    expect("nextAcceptedAtMs" in invalid).toBe(false);
    expect("nextCreditMs" in invalid).toBe(false);
  });

  it("repeated rejections never bank more than maxBurstMs, however many occur", () => {
    let acceptedAtMs = 1000;
    let creditMs = 0;
    // 500px stays within DEFAULT_MOVEMENT_CONFIG's bounds (8000x8000) so every
    // rejection here is genuinely max_speed_exceeded, never out_of_bounds —
    // even at the maxBurstMs=200ms cap, maxAllowed is only 2000*0.201≈402px.
    // Each iteration only ever advances the budget by 1ms (nowMs = acceptedAtMs + 1),
    // so it takes maxBurstMs (200) iterations to reach the cap exactly — run well past that.
    for (let i = 0; i < 250; i++) {
      const nowMs = acceptedAtMs + 1; // same-tick drain every time
      const r = validateMove({ x: 500, y: 0 }, { position: { x: 0, y: 0 }, acceptedAtMs, creditMs }, nowMs, cfg);
      expect(r.accepted).toBe(false);
      if (r.accepted || r.reason !== "max_speed_exceeded") throw new Error("expected max_speed_exceeded");
      acceptedAtMs = r.nextAcceptedAtMs;
      creditMs = r.nextCreditMs;
      expect(creditMs).toBeLessThanOrEqual(cfg.maxBurstMs);
    }
    expect(creditMs).toBe(cfg.maxBurstMs); // converges to the cap, never past it
  });

  it("a malicious large jump is still rejected even with the maximum possible banked credit", () => {
    // Best case for an attacker: full maxBurstMs already banked.
    const previous = { position: { x: 0, y: 0 }, acceptedAtMs: 1000, creditMs: cfg.maxBurstMs };
    const r = validateMove({ x: 2000, y: 0 }, previous, 1000, cfg); // 0ms elapsed, 2000px jump
    expect(r.accepted).toBe(false);
    // maxAllowed = 2000px/s * 0.2s (maxBurstMs) = 400px — a 2000px jump fails by 5x regardless.
  });

  /** Drives validateMove exactly like RoomManager.applyMove does POST-fix:
   *  position/acceptedAtMs/creditMs all advance on accept; on a
   *  max_speed_exceeded reject, only acceptedAtMs/creditMs advance
   *  (position stays put) — see roomManager.ts's applyMove. */
  function walkPostFix(steps: { nowMs: number; x: number }[], start = { acceptedAtMs: 0, creditMs: 0, x: 0 }) {
    let acceptedAtMs = start.acceptedAtMs;
    let creditMs = start.creditMs;
    let position = { x: start.x, y: 0 };
    return steps.map((step) => {
      const r = validateMove({ x: step.x, y: 0 }, { position, acceptedAtMs, creditMs }, step.nowMs, cfg);
      if (r.accepted) {
        position = r.position;
        acceptedAtMs = step.nowMs;
        creditMs = r.nextCreditMs;
      } else if (r.reason === "max_speed_exceeded") {
        acceptedAtMs = r.nextAcceptedAtMs;
        creditMs = r.nextCreditMs;
      }
      return r.accepted;
    });
  }

  it("stops the gap from growing without bound once real pacing resumes, and eventually re-converges — but NOT necessarily on the very next message", () => {
    // Reproduces the production shape: one normal 50ms-paced accepted step
    // (typical mid-walk banking, not a big post-idle credit), then one
    // message drained 1ms later (lost to the burst), then real ~50ms client
    // pacing resumes. Every number here is worked by hand in this review —
    // see the review notes for the full derivation.
    const outcomes = walkPostFix([
      { nowMs: 50, x: 75 }, // accepted: banks only ~12.5ms credit (a normal mid-walk gap, not idle-then-move)
      { nowMs: 51, x: 150 }, // drained 1ms later: rejected (13.5ms budget can't justify 75px)
      { nowMs: 101, x: 225 }, // real ~50ms pacing resumes: STILL rejected — the gap accrued during
      // the lost message (150px: client at 225, server frozen at 75) is briefly wider than what one
      // fresh 50ms cycle can justify (127px) — this is precisely the case the review flagged: the
      // server fix guarantees the ceiling stops shrinking, not that recovery is instant.
      { nowMs: 151, x: 300 }, // a second real-paced cycle: NOW accepted (225px gap fits a 227px ceiling)
    ]);
    expect(outcomes).toEqual([true, false, false, true]);
    // Once real pacing continues, ordinary walking resumes exactly as normal —
    // the fix's guarantee is that the peer is never PERMANENTLY stuck (the
    // ceiling stabilizes and the gap stops growing every message, unlike
    // before this fix), not that a single burst is invisible. This is why
    // Approach A's approval explicitly requires empirical load-test
    // verification, not just this proof, before trusting real seat-claim
    // recovery rates end to end.
  });
});
