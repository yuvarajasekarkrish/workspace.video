import type { Point } from "@cosmos/shared";
import { DEFAULT_MOVEMENT_CONFIG, type MovementConfig } from "@cosmos/shared";

export type MoveRejectionReason = "out_of_bounds" | "max_speed_exceeded" | "invalid";

export type MoveValidationResult =
  | { accepted: true; position: Point; nextCreditMs: number }
  | { accepted: false; reason: MoveRejectionReason; correctedPosition: Point };

/**
 * Server-authoritative validation for a single `move` update. Pure function:
 * given the previously-accepted position/time and the proposed new one, decide
 * whether to accept it, so the realtime server never lets a client teleport or
 * submit non-finite coordinates into room state (which proximity and media
 * decisions are derived from).
 *
 * Teleport-style repositioning (spawn, follow, jump-to-object) must go through
 * a separate server action that sets position directly — never through this
 * validator with the speed check relaxed.
 */
export function validateMove(
  proposed: Point,
  previous: { position: Point; acceptedAtMs: number; creditMs?: number },
  nowMs: number,
  config: MovementConfig = DEFAULT_MOVEMENT_CONFIG,
): MoveValidationResult {
  if (!Number.isFinite(proposed.x) || !Number.isFinite(proposed.y)) {
    return { accepted: false, reason: "invalid", correctedPosition: previous.position };
  }

  if (
    proposed.x < 0 ||
    proposed.y < 0 ||
    proposed.x > config.roomWidthPx ||
    proposed.y > config.roomHeightPx
  ) {
    const clamped: Point = {
      x: Math.min(Math.max(proposed.x, 0), config.roomWidthPx),
      y: Math.min(Math.max(proposed.y, 0), config.roomHeightPx),
    };
    return { accepted: false, reason: "out_of_bounds", correctedPosition: clamped };
  }

  // Elapsed time is measured on the SERVER's clock, so a server stall that
  // delivers two moves together makes the second look impossibly fast even
  // though the user did nothing wrong. `creditMs` is the unspent allowance
  // banked from earlier accepted moves (capped at config.maxBurstMs), added
  // to the elapsed time so a short stall does not read as a speed violation.
  const budgetMs = Math.max(0, nowMs - previous.acceptedAtMs) + (previous.creditMs ?? 0);
  const elapsedSec = budgetMs / 1000;
  const dx = proposed.x - previous.position.x;
  const dy = proposed.y - previous.position.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  // Grace window: don't divide by ~0 elapsed time into a false-positive reject
  // for updates arriving back-to-back (e.g. right after a resync).
  const maxAllowed = config.maxSpeedPxPerSec * Math.max(elapsedSec, 0.001);

  if (dist > maxAllowed) {
    return {
      accepted: false,
      reason: "max_speed_exceeded",
      correctedPosition: previous.position,
    };
  }

  // What this move actually cost, at full speed; the rest of the budget is
  // banked for the next move, up to the cap.
  const consumedMs = (dist / config.maxSpeedPxPerSec) * 1000;
  const nextCreditMs = Math.min(config.maxBurstMs, Math.max(0, budgetMs - consumedMs));
  return { accepted: true, position: proposed, nextCreditMs };
}
