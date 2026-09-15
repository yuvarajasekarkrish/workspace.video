import { z } from "zod";
import type { Point } from "../geometry";
import type { LayoutZone, RoomLayout, Seat } from "./types";
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
