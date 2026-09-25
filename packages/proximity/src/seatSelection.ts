import type { Point } from "@workspace-video/shared";

/**
 * Pure candidate-ordering logic for Part 4B's auto-seating strategies
 * (auto-seat-within-table, nearby-seat search) — sibling to
 * seatOccupancy.ts's resolveSeatClaim, same "no I/O, testable without a
 * server" contract. Neither function here performs the actual atomic
 * claim: each only narrows a table/desk group or a search radius down to
 * an ordered list of candidate seats. The caller (RoomManager.selectSeat)
 * still runs every candidate through the SAME resolveSeatClaim atomic
 * check claimSeat uses, in order, stopping at the first one that succeeds
 * — so no new occupancy logic exists, and no duplicate seat assignment is
 * possible: two concurrent selectSeat calls for the same table can't
 * interleave (Node runs each synchronous call to completion), so the
 * second call's occupancy check always sees the first's already-written
 * claim.
 */

export interface SelectableSeat {
  id: string;
  anchor: Point;
}

/** Every seat in `candidates` not currently occupied by someone else than
 *  `requestingUserId`, in their given order — the deterministic "fill this
 *  table's free seats first, in a stable order, never negotiate a taken
 *  one away" rule the auto-seat-within-table strategy needs. A seat the
 *  requesting user already occupies counts as free for them, matching
 *  resolveSeatClaim's own re-claim-is-a-no-op rule. */
export function freeSeatsInOrder<T extends SelectableSeat>(
  candidates: readonly T[],
  occupantOf: (seatId: string) => string | undefined,
  requestingUserId: string,
): T[] {
  return candidates.filter((seat) => {
    const occupant = occupantOf(seat.id);
    return !occupant || occupant === requestingUserId;
  });
}

/** Free seats within `radiusPx` of `origin`, nearest first — the candidate
 *  set for the nearby-seat-search strategy. `origin` may be a client-
 *  supplied point (it only narrows WHICH seats get tried); it is never
 *  used to bypass a proximity check itself — the caller still runs each
 *  candidate through resolveSeatClaim, which validates against the peer's
 *  own server-authoritative position regardless of what this function was
 *  asked to search near, exactly as an ordinary exact-seat claim does. */
export function nearbyFreeSeats<T extends SelectableSeat>(
  candidates: readonly T[],
  origin: Point,
  radiusPx: number,
  occupantOf: (seatId: string) => string | undefined,
  requestingUserId: string,
): T[] {
  return candidates
    .map((seat) => {
      const dx = seat.anchor.x - origin.x;
      const dy = seat.anchor.y - origin.y;
      return { seat, dist: Math.sqrt(dx * dx + dy * dy) };
    })
    .filter(({ dist }) => dist <= radiusPx)
    .filter(({ seat }) => {
      const occupant = occupantOf(seat.id);
      return !occupant || occupant === requestingUserId;
    })
    .sort((a, b) => a.dist - b.dist)
    .map(({ seat }) => seat);
}
