import type { Point } from "../geometry";

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
}

/** A place a peer can sit. The only interactive geometry this phase — see
 *  the plan's hot-desk seating protocol. `zoneId`, when present, is what
 *  lets zone audio and zone occupancy counts include seated peers. */
export interface Seat {
  id: string;
  label: string;
  anchor: Point;
  zoneId?: string;
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
}

export interface RoomLayout {
  id: string;
  floor: { cols: number; rows: number };
  spawnZoneId: string;
  furniture: FurniturePiece[];
  seats: Seat[];
  zones: LayoutZone[];
}
