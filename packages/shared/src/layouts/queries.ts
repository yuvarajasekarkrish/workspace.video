import { z } from "zod";
import type { Point } from "../geometry";
import type { FurniturePiece, LayoutZone, RoomLayout, Seat } from "./types";
import { pointInTileRect } from "./grid";
import { DEFAULT_LAYOUT_ID, resolveLayout } from "./registry";

/** The smallest zone containing `point`, or null. "Smallest wins" so a
 *  zone nested inside a larger one (not used by openOffice@1 today, but a
 *  real future case — a stage inside a bigger hall) resolves to the more
 *  specific zone rather than whichever happens to be listed first. */
export function zoneAt(layout: RoomLayout, point: Point): LayoutZone | null {
  let best: LayoutZone | null = null;
  let bestArea = Infinity;
  for (const zone of layout.zones) {
    if (!pointInTileRect(point, zone.rect)) continue;
    const area = zone.rect.cols * zone.rect.rows;
    if (area < bestArea) {
      best = zone;
      bestArea = area;
    }
  }
  return best;
}

export function seatById(layout: RoomLayout, seatId: string): Seat | undefined {
  return layout.seats.find((s) => s.id === seatId);
}

/** The shared-table/desk-group id a seat belongs to, derived from its own id
 *  rather than a separate stored field — every seat generator in
 *  modules.ts (deskGrid, privateCabin, meetingRoom, collaboration tables,
 *  pods) builds a seat's id as `${groupIdPrefix}-<seatSuffix>` (e.g.
 *  `desk-12-a`/`desk-12-b`, `cabin-3-a`/`cabin-3-b`, `pod-4-seat`), so
 *  stripping the trailing `-<suffix>` segment recovers exactly the id
 *  every chair/table FurniturePiece at that same table also shares as its
 *  own prefix. Confirmed against every real generator in modules.ts before
 *  relying on it, per the "check real variants before assuming" rule —
 *  this is not a guess at a convention, it's the one every seat id in the
 *  codebase already follows. */
export function tableGroupIdForSeat(seatId: string): string {
  return seatId.replace(/-[^-]+$/, "");
}

/** Every seat sharing `seatId`'s table/desk group (including `seatId`
 *  itself), in the layout's own seat order — used by the auto-seat-within-
 *  table selection strategy to find alternatives at the same table when the
 *  originally requested seat is unavailable. Returns just `[seat]` if the
 *  seat exists but no sibling shares its group id (nothing to fall back to
 *  within the table), and `[]` if the seat itself doesn't exist. */
export function seatsAtSameTable(layout: RoomLayout, seatId: string): Seat[] {
  const seat = seatById(layout, seatId);
  if (!seat) return [];
  // Explicit membership wins, and never mixes with the prefix rule: a seat
  // that names its table matches only seats naming the same table.
  if (seat.tableId !== undefined) return layout.seats.filter((s) => s.tableId === seat.tableId);
  const groupId = tableGroupIdForSeat(seatId);
  return layout.seats.filter((s) => s.tableId === undefined && tableGroupIdForSeat(s.id) === groupId);
}

export function zoneById(layout: RoomLayout, zoneId: string): LayoutZone | undefined {
  return layout.zones.find((z) => z.id === zoneId);
}

/** Nearest seat within `radiusPx` of `worldPoint`, or null — the seat
 *  equivalent of canvas/objects/objectHitTest.ts's approach (pure
 *  world-space math, no Pixi/DOM dependency, so it's testable without a
 *  canvas and reusable by both the click-to-sit gesture and any future
 *  find-a-seat UI). */
export function hitTestSeats(layout: RoomLayout, worldPoint: Point, radiusPx = 28): Seat | null {
  let best: Seat | null = null;
  let bestDist = radiusPx;
  for (const seat of layout.seats) {
    const dx = seat.anchor.x - worldPoint.x;
    const dy = seat.anchor.y - worldPoint.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist <= bestDist) {
      best = seat;
      bestDist = dist;
    }
  }
  return best;
}

/** The `desk`/`table` furniture piece under `worldPoint`, or null — lets a
 *  click that misses every chair's small hitTestSeats radius (a click on
 *  the shared table surface itself, not one specific seat) still resolve
 *  to "the user wants a seat at THIS table", the trigger for the
 *  auto-seat-within-table selection strategy. Axis-aligned only: every
 *  `desk`/`table` piece modules.ts generates has rotation 0 (only their
 *  chairs rotate to face the table), so a plain bounding-box test is exact
 *  for every real layout today, not an approximation. */
export function furnitureAt(layout: RoomLayout, worldPoint: Point): FurniturePiece | null {
  for (const piece of layout.furniture) {
    if (piece.kind !== "desk" && piece.kind !== "table") continue;
    if (
      worldPoint.x >= piece.x &&
      worldPoint.x <= piece.x + piece.width &&
      worldPoint.y >= piece.y &&
      worldPoint.y <= piece.y + piece.height
    ) {
      return piece;
    }
  }
  return null;
}

const RoomConfigShape = z.object({ layoutId: z.string().min(1) }).partial();

/** Parses a room's free-form `config` Json into a resolved layout id,
 *  falling back to DEFAULT_LAYOUT_ID for anything malformed, missing, or
 *  naming a layout that isn't (or is no longer) registered — a bad
 *  Room.config must never brick a room (see the plan's registry docs). */
export function parseRoomConfig(config: unknown): { layoutId: string } {
  const parsed = RoomConfigShape.safeParse(config);
  const candidate = parsed.success ? parsed.data.layoutId : undefined;
  if (candidate && resolveLayout(candidate)) {
    return { layoutId: candidate };
  }
  return { layoutId: DEFAULT_LAYOUT_ID };
}
