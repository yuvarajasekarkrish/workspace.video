import type { Point } from "../geometry";
import type { ZoneAccessPolicy } from "../permissions";

/**
 * Data model for a product-designed office floor. Deliberately does NOT
 * depend on plans.ts — a layout describes what the office looks like, never
 * how many people may enter it (that's the workspace's plan; see
 * participantLimit.ts). The same layout serves every plan.
 */

export type FurnitureKind =
  | "desk"
  | "table"
  | "chair"
  | "sofa"
  | "plant"
  | "counter"
  | "wall"
  | "door"
  | "screen"
  | "stage"
  | "whiteboard";

/** Pure geometry, zero runtime state — rendered once, never touched by the
 *  per-frame render loop (see the Phase 8 plan's rendering section). */
export interface FurniturePiece {
  id: string;
  kind: FurnitureKind;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  label?: string;
  /** Rendering-only multiplier on how big this piece is DRAWN — never read
   *  by any layout, occupancy, or movement logic. `width`/`height` above
   *  remain the piece's logical footprint (what `chairGap`-style placement
   *  formulas use, and what a bounding-box hit test like `furnitureAt`
   *  checks); `Seat.anchor` is completely unaffected by this field, since
   *  every seat anchor is computed once at layout-generation time from
   *  `width`/`height`, never re-derived from a piece's rendered size.
   *  Absent (or `1`) means "draw at its logical size" — the behavior every
   *  piece had before this field existed, so no existing layout's
   *  appearance changes until a template explicitly sets this. See
   *  `chair()` in modules.ts for where a generator may set it, and
   *  `drawChair` in apps/web/src/canvas/furniture3d.ts for the one place
   *  it is read. */
  visualScale?: number;
  /** For a chair: the one Seat this chair belongs to. Optional, additive —
   *  older generators never set it (their chair and seat are linked only by
   *  sharing the same center point), so nothing reads it as required. */
  seatId?: string;
}

/** A place a peer can sit. The only interactive geometry this phase — see
 *  the plan's hot-desk seating protocol. `zoneId`, when present, is what
 *  lets zone audio and zone occupancy counts include seated peers. */
export interface Seat {
  id: string;
  label: string;
  anchor: Point;
  zoneId?: string;
  /** Explicit table-group membership: the id of the table furniture piece
   *  this seat belongs to. When present it is the ONLY thing that decides
   *  which seats share a table (see seatsAtSameTable) — no seat-id parsing.
   *  Absent on every seat generated before this field existed (office300@1),
   *  which keep the original seat-id-prefix grouping unchanged. */
  tableId?: string;
}

export type ZoneKind = "meeting" | "cabin" | "stage" | "audience" | "open" | "focus" | "lobby";

export interface TileRect {
  col: number;
  row: number;
  cols: number;
  rows: number;
}

export interface LayoutZone {
  id: string;
  label: string;
  kind: ZoneKind;
  rect: TileRect;
  /** Advisory only (no collision this phase) — drives a "4/12" display, not
   *  an enforced cap. See the plan's R4. */
  capacity?: number;
  /** For an `audience` zone: the `stage` zone it faces, for the directed
   *  zone-audio broadcast rule (see packages/proximity/src/zoneAudio.ts). */
  stageId?: string;
  /** Absent (or `{ kind: "open" }`) means anyone who is already a member of
   *  the room's workspace may enter — the behavior every zone had before
   *  this field existed, so no existing layout changes behavior. See
   *  permissions.ts's canEnterZone, enforced by RoomManager's
   *  claimSeat/teleportTo/applyMove. */
  access?: ZoneAccessPolicy;
}

export interface RoomLayout {
  id: string;
  floor: { cols: number; rows: number };
  spawnZoneId: string;
  furniture: FurniturePiece[];
  seats: Seat[];
  zones: LayoutZone[];
}
