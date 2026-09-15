import type { Point } from "@cosmos/shared";

/**
 * Pure decision logic for a hot-desk seat claim — sibling to objectLww.ts
 * and movement.ts, same "no I/O, testable without a server" contract.
 * RoomManager owns the actual seat/seatOf maps and calls this synchronously
 * (no await between reading current occupancy and writing the result),
 * which is what makes first-writer-wins hold for two claims racing for the
 * same seat: the second call always sees the first's already-written
 * occupancy.
 *
 * The claimant's position is the server's own last-accepted position for
 * that peer, never a client-supplied point — trusting a client-reported
 * position for the proximity check would make "sitting" a free teleport.
 */
export interface SeatInfo {
  id: string;
  anchor: Point;
}

export type SeatClaimResult =
  | { accepted: true; seatId: string; previousSeatId: string | null }
  | { accepted: false; reason: "unknown_seat" | "occupied" | "out_of_range" };

export const DEFAULT_SEAT_CLAIM_RADIUS_PX = 120;

export function resolveSeatClaim(
  seat: SeatInfo | undefined,
  claimantPosition: Point,
  /** userId currently occupying the target seat, if any. */
  occupiedBy: string | undefined,
  claimantUserId: string,
  /** The seat the claimant is currently sitting in, if any — released as
   *  part of an accepted claim on a different seat. */
  currentSeatOfClaimant: string | null,
  radiusPx: number = DEFAULT_SEAT_CLAIM_RADIUS_PX,
): SeatClaimResult {
  if (!seat) {
    return { accepted: false, reason: "unknown_seat" };
  }

  // Re-claiming the seat you're already in is a harmless no-op, not a
  // conflict — occupiedBy === claimantUserId falls through to acceptance.
  if (occupiedBy && occupiedBy !== claimantUserId) {
    return { accepted: false, reason: "occupied" };
  }

  const dx = seat.anchor.x - claimantPosition.x;
  const dy = seat.anchor.y - claimantPosition.y;
  if (Math.sqrt(dx * dx + dy * dy) > radiusPx) {
    return { accepted: false, reason: "out_of_range" };
  }

  return {
    accepted: true,
    seatId: seat.id,
    previousSeatId: currentSeatOfClaimant !== seat.id ? currentSeatOfClaimant : null,
  };
}
