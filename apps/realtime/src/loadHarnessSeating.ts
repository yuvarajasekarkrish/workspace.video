import type { Point } from "@workspace-video/shared";

/**
 * Helpers for seating people in the load test. The server seats someone only when they stand within
 * 120 px of the seat and answers "out_of_range" otherwise, so a test that sends "sit" from wherever
 * people arrived mostly gets refused. These let the test walk each person to their seat first, and
 * count what the server actually answered instead of assuming every request worked.
 */

/** One step from `from` toward `to`, at most `maxStepPx` long; lands exactly on `to` when close. */
export function stepToward(from: Point, to: Point, maxStepPx: number): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= maxStepPx) return { x: to.x, y: to.y };
  return { x: from.x + (dx / distance) * maxStepPx, y: from.y + (dy / distance) * maxStepPx };
}

export interface SeatClaimSummary {
  attempted: number;
  accepted: number;
  /** Refusals by the reason the server gave, for example { out_of_range: 12 }. */
  refused: Record<string, number>;
}

/** What the server answered to the seat claims: accepted, or refused and why. A missing or
 *  unreadable answer is counted as "no_reply" so nothing is dropped from the total. */
export function summarizeSeatAcks(acks: readonly unknown[]): SeatClaimSummary {
  const summary: SeatClaimSummary = { attempted: acks.length, accepted: 0, refused: {} };
  for (const ack of acks) {
    const reply = typeof ack === "object" && ack !== null ? (ack as { ok?: unknown; error?: unknown }) : {};
    if (reply.ok === true) {
      summary.accepted += 1;
    } else {
      const reason = typeof reply.error === "string" ? reply.error : "no_reply";
      summary.refused[reason] = (summary.refused[reason] ?? 0) + 1;
    }
  }
  return summary;
}
