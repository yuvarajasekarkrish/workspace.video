import type { Point } from "../geometry";
import type { MovementConfig } from "../proximity-config";
import type { RoomLayout, TileRect } from "./types";

/** One grid cell, in world px. Furniture/seat coordinates are plain world
 *  px (not tile-snapped) so modules can place things anywhere within a
 *  TileRect — the grid is a layout-authoring convenience, not a runtime
 *  constraint (there is no collision this phase; see the plan's R5). */
export const TILE_PX = 160;

export function tileRectToWorld(rect: TileRect): { x: number; y: number; width: number; height: number } {
  return {
    x: rect.col * TILE_PX,
    y: rect.row * TILE_PX,
    width: rect.cols * TILE_PX,
    height: rect.rows * TILE_PX,
  };
}

export function tileRectCenter(rect: TileRect): Point {
  const box = tileRectToWorld(rect);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** A point lies inside a TileRect's world-px bounds (inclusive of the near
 *  edge, exclusive of the far edge — matches zoneAt's containment rule). */
export function pointInTileRect(point: Point, rect: TileRect): boolean {
  const box = tileRectToWorld(rect);
  return point.x >= box.x && point.x < box.x + box.width && point.y >= box.y && point.y < box.y + box.height;
}

/** Derives the MovementConfig for a layout's floor, so the server's
 *  validateMove and the client's movement math both use the SAME bounds
 *  instead of the global DEFAULT_MOVEMENT_CONFIG — this is what makes it
 *  impossible to walk off a room's floor. Speed/throttle are left at their
 *  defaults; only the room dimensions are layout-specific. */
export function movementConfigForLayout(
  layout: RoomLayout,
  base: Pick<MovementConfig, "clientThrottleMs" | "maxSpeedPxPerSec">,
): MovementConfig {
  return {
    ...base,
    roomWidthPx: layout.floor.cols * TILE_PX,
    roomHeightPx: layout.floor.rows * TILE_PX,
  };
}
