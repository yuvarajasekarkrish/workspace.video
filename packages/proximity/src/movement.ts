import type { Point } from "@workspace-video/shared";
import { DEFAULT_MOVEMENT_CONFIG, type MovementConfig } from "@workspace-video/shared";

export type MoveRejectionReason = "out_of_bounds" | "max_speed_exceeded" | "invalid";

export type MoveValidationResult =
  | { accepted: true; position: Point; nextCreditMs: number }
  | { accepted: false; reason: "out_of_bounds" | "invalid"; correctedPosition: Point }
  | {
      accepted: false;
      reason: "max_speed_exceeded";
      correctedPosition: Point;
      /** Bounded-credit resync (see validateMove's docs on same-tick message
       *  bursts) — present ONLY for this reason. `position` is never included
       *  here: the server stays authoritative on WHERE the peer is, and a
       *  rejected move never happened, so it must not advance. These two
       *  fields let the caller (RoomManager.applyMove) advance ONLY its time
       *  bookkeeping (when it last checked) and its bounded speed allowance
       *  (how much it may move next), never its position. */
      nextAcceptedAtMs: number;
      nextCreditMs: number;
    };

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
export type TeleportRejectionReason = "out_of_bounds" | "invalid";

export type TeleportValidationResult =
  | { accepted: true; position: Point }
  | { accepted: false; reason: TeleportRejectionReason; correctedPosition: Point };

/**
 * Server-authoritative validation for a discrete relocation (click-to-move,
 * walk-to-person, walk-to-zone) — the "separate server action" validateMove's
 * own doc comment calls for. Deliberately does NOT run the continuous-speed
 * check: that check exists to catch travel faster than physically plausible
 * OVER TIME, which has no meaning for a single deliberate jump. Still fully
 * server-authoritative — bounds are enforced exactly like validateMove, and
 * the caller (RoomManager.teleportTo) resets the peer's movement-credit
 * window the same way an accepted seat-claim already does, so a teleport can
 * never be laundered into extra speed budget for the moves that follow it.
 */
export function validateTeleport(target: Point, config: MovementConfig = DEFAULT_MOVEMENT_CONFIG): TeleportValidationResult {
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    return { accepted: false, reason: "invalid", correctedPosition: { x: 0, y: 0 } };
  }

  if (target.x < 0 || target.y < 0 || target.x > config.roomWidthPx || target.y > config.roomHeightPx) {
    const clamped: Point = {
      x: Math.min(Math.max(target.x, 0), config.roomWidthPx),
      y: Math.min(Math.max(target.y, 0), config.roomHeightPx),
    };
    return { accepted: false, reason: "out_of_bounds", correctedPosition: clamped };
  }

  return { accepted: true, position: target };
}

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
    // Nothing was spent (this move never happened), so the WHOLE budget is
    // still unspent real time — bank it, capped exactly like an accepted
    // move's leftover would be, and reset the timestamp so the NEXT check
    // starts counting fresh from now rather than from an increasingly stale
    // point. Without this, a same-tick burst of otherwise-legitimate,
    // correctly-paced messages (see the "double-drain" investigation this
    // fixes) permanently diverges: previous.position/acceptedAtMs would
    // never move again, so every later message in the burst is measured
    // against an ever-more-stale reference and is guaranteed to fail too.
    // `position` is deliberately never touched here — only bookkeeping
    // (when we last checked, how much allowance is banked) advances; WHERE
    // the peer authoritatively is stays exactly where it was, exactly as
    // before this change.
    return {
      accepted: false,
      reason: "max_speed_exceeded",
      correctedPosition: previous.position,
      nextAcceptedAtMs: nowMs,
      nextCreditMs: Math.min(config.maxBurstMs, budgetMs),
    };
  }

  // What this move actually cost, at full speed; the rest of the budget is
  // banked for the next move, up to the cap.
  const consumedMs = (dist / config.maxSpeedPxPerSec) * 1000;
  const nextCreditMs = Math.min(config.maxBurstMs, Math.max(0, budgetMs - consumedMs));
  return { accepted: true, position: proposed, nextCreditMs };
}
