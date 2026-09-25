import type { Point } from "./geometry";
import type { WorkspaceRoleName } from "./permissions";

/**
 * Contracts for the extensible auto-seating engine (Part 4B of the
 * destination-access-control/auto-seating design — Part 4A, the access-
 * control enforcement these contracts sit alongside, is implemented in
 * RoomManager and unaffected by any of this). Implemented by
 * `RoomManager.selectSeat` (apps/realtime), which resolves candidates per
 * strategy (using packages/proximity's seatSelection.ts helpers, plus
 * seatsAtSameTable from packages/shared's layout queries) and commits the
 * chosen seat through the SAME atomic resolveSeatClaim path claimSeat
 * already uses — no duplicate occupancy logic, no new way to double-book a
 * seat. `SeatSelectionStrategy` below documents the shape a future
 * strategy would take if the switch-based v1 in RoomManager.selectSeat
 * ever needs to become a real registry; today's implementation is that
 * switch, not this interface.
 */

/** What a workspace has actually turned on. The client must only ever offer
 *  a seating choice this config allows for the CURRENT room's workspace —
 *  never assume a capability exists. Every field defaults to today's only
 *  real behavior (exact-seat, nothing else) so an unconfigured workspace's
 *  seating behaves exactly as it does before Part 4B ships. */
export interface WorkspaceSeatingConfig {
  /** "Click a table (not one specific chair) and get seated in the next
   *  free seat at it" — the AutoSeatWithinTable strategy. */
  autoSeatWithinTableEnabled: boolean;
  /** Expanding-radius search for a free seat near a point that has none of
   *  its own (e.g. clicking bare floor near a full table). */
  nearbySearchEnabled: boolean;
  /** How far NearbySeatSearch may look, in px, when enabled. */
  nearbySearchRadiusPx: number;
  /** Stand at a location with no seat at all, as an explicit fallback
   *  rather than a failure — distinct from today's implicit "click empty
   *  floor, just walk there" (movement), this is specifically an outcome a
   *  seat-selection REQUEST can resolve to. */
  standingFallbackEnabled: boolean;
  /** Queue for a seat that's currently full, notified when one frees up.
   *  Not implemented anywhere yet — flag exists so the config shape doesn't
   *  need to change again the day it is. */
  waitlistEnabled: boolean;
  /** Seat a whole group together (e.g. everyone who joined a meeting link
   *  together) as one selection request. Not implemented anywhere yet, same
   *  reasoning as waitlistEnabled. */
  groupSeatingEnabled: boolean;
}

/** Every field OFF/at today's default — the config an unconfigured
 *  workspace effectively has. Exact-seat clicks (already implemented, never
 *  gated by this config) are unaffected either way. */
export const DEFAULT_WORKSPACE_SEATING_CONFIG: WorkspaceSeatingConfig = {
  autoSeatWithinTableEnabled: false,
  nearbySearchEnabled: false,
  nearbySearchRadiusPx: 200,
  standingFallbackEnabled: false,
  waitlistEnabled: false,
  groupSeatingEnabled: false,
};

/** The strategies a seat-selection request may name. `"exact"` is today's
 *  only real behavior (click a specific seatId, get exactly that seat or a
 *  rejection — see RoomManager.claimSeat, unchanged by any of this). Every
 *  other value is only actually attempted if the workspace's
 *  WorkspaceSeatingConfig has the matching flag on — requesting a disabled
 *  strategy is itself an error the engine must surface, not a silent
 *  fallback to a different one it picked instead (see the plan's "no
 *  negotiation" requirement, already enforced for `"exact"` today). */
export type SeatSelectionStrategyName = "exact" | "autoSeatWithinTable" | "nearbySearch" | "standingFallback" | "waitlist" | "groupSeating";

/** One user's seat-selection request — the per-request choice layer,
 *  distinct from both the workspace's enabled-features config above and any
 *  saved per-user default preference (a separate, simpler concern: which
 *  strategy to use when the user doesn't say — not defined here, since it's
 *  just "look up a stored StrategyName for this user" wherever it's read
 *  from, not a new contract of its own). `userId`/`roomId` are deliberately
 *  NOT fields here — every RoomManager method already takes both as
 *  explicit parameters (see claimSeat/teleportTo/applyMove), and
 *  RoomManager.selectSeat follows that same convention rather than
 *  duplicating identity inside the request payload. */
export interface SeatSelectionRequest {
  strategy: SeatSelectionStrategyName;
  /** The specific seat for `"exact"`, or the table/desk-group anchor point
   *  for `"autoSeatWithinTable"`/`"nearbySearch"`. */
  target: { seatId: string } | { point: Point };
}

/** Every reason a seat-selection request can fail with. `"unknown_seat"`,
 *  `"occupied"`, and `"out_of_range"` are resolveSeatClaim's own reasons
 *  (see seatOccupancy.ts), surfaced unchanged when a candidate seat fails
 *  the atomic claim. `"access_denied"` is Part 4A's destination access
 *  control (see permissions.ts's canEnterZone). `"not_enabled"` is a
 *  strategy the requesting workspace hasn't turned on in its
 *  WorkspaceSeatingConfig. `"table_full"`/`"no_seat_nearby"` mean the
 *  strategy ran but found no free candidate at all. `"invalid_request"` is
 *  a malformed request (e.g. a point given where a strategy needs a
 *  seatId). `"not_supported"` is standing/waitlist/group seating — always
 *  refused today, since none of those are implemented yet regardless of
 *  any config flag. */
export type SeatSelectionFailureReason =
  | "unknown_seat"
  | "occupied"
  | "out_of_range"
  | "access_denied"
  | "not_enabled"
  | "table_full"
  | "no_seat_nearby"
  | "invalid_request"
  | "not_supported";

export type SeatSelectionResult =
  | { outcome: "seated"; seatId: string }
  | { outcome: "standing"; position: Point }
  | { outcome: "waitlisted" }
  | { outcome: "failed"; reason: SeatSelectionFailureReason };

/** One strategy in the selection pipeline. Deliberately narrow and pure-
 *  shaped (no I/O in the type signature) so a new strategy is one new
 *  object implementing this interface, never a new branch inside a shared
 *  function — see the plan's "add strategies without rewriting the core"
 *  requirement. The real implementation (not written yet) is expected to
 *  take the room's current seat/occupancy state as a parameter here;
 *  intentionally left unspecified until Part 4B actually builds it, so this
 *  contract doesn't lock in a shape for data nothing reads yet. */
export interface SeatSelectionStrategy {
  name: SeatSelectionStrategyName;
  select(request: SeatSelectionRequest, config: WorkspaceSeatingConfig): SeatSelectionResult;
}

/** Where the workspace's seating config and a user's own saved default
 *  preference come from — not designed further than this contract, since
 *  neither is implemented; kept here only so Part 4B's engine has a stable
 *  shape to accept them in when it exists. `role` is threaded through
 *  because a future strategy may reasonably depend on it (distinct from,
 *  and never a substitute for, the destination access-control check in
 *  RoomManager, which every strategy's chosen seat must still pass). */
export interface SeatSelectionContext {
  workspaceConfig: WorkspaceSeatingConfig;
  userRole: WorkspaceRoleName | null;
  savedPreference?: SeatSelectionStrategyName;
}
