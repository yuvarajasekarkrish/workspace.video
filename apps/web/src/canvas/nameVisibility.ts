import type { Point } from "@workspace-video/shared";

/**
 * Which people's names should draw on the map right now (docs/architecture/company-map-builder.md,
 * D17 decision 5B): "A person's name tag draws at 16 px only for the local person, people nearby,
 * the person under the mouse and anyone found through search; everyone else is a plain dot until
 * the map is zoomed in." Pure and store-free, unlike PixiStage, so the rule itself is unit-tested on
 * its own and PixiStage only wires positions and events into it once a frame.
 */

function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface NameVisibilityInput {
  /** Every currently-known peer's render position, including the local person. */
  positions: ReadonlyMap<string, Point>;
  localUserId: string;
  /** "Nearby" (D17 5B) reuses the video-visibility radius (packages/shared's
   *  proximity-config.ts DEFAULT_PROXIMITY_CONFIG.videoRadiusPx) — the distance at which the room
   *  already treats two people as close enough to matter to each other. */
  nearbyRadiusPx: number;
  /** Whoever the mouse is currently over (attachHover), or null. */
  hoveredUserId: string | null;
  /** Whoever was last found through the people search (walkToPerson), or null. */
  highlightedUserId: string | null;
}

/** The set of userIds whose name tag should be visible right now. Everyone else gets a plain dot. */
export function computeNameVisibility(input: NameVisibilityInput): Set<string> {
  const { positions, localUserId, nearbyRadiusPx, hoveredUserId, highlightedUserId } = input;
  const visible = new Set<string>();
  const local = positions.get(localUserId);
  if (local) visible.add(localUserId);

  for (const [userId, position] of positions) {
    if (userId === localUserId) continue;
    const nearby = local ? distance(local, position) <= nearbyRadiusPx : false;
    if (nearby || userId === hoveredUserId || userId === highlightedUserId) visible.add(userId);
  }
  return visible;
}
