import {
  DEFAULT_LAYOUT_ID,
  DEFAULT_MOVEMENT_CONFIG,
  listLayoutIds,
  movementConfigForLayout,
  resolveLayout,
  type MovementConfig,
  type RoomLayout,
} from "@workspace-video/shared";

/**
 * What the load test runs on, read from the environment. With nothing set it is exactly what the
 * test always did (the app's own default layout, half the people seated), so earlier result files stay comparable.
 *
 *   LOAD_HARNESS_LAYOUT_ID       a layout name, for example office300@1 (default office300@1)
 *   LOAD_HARNESS_SEATED_FRACTION 0 to 1, the share of people who take a seat (default 0.5)
 *   LOAD_HARNESS_WALK_TO_SEAT    1 = walk each person to their seat before they sit, because the
 *                                server refuses a seat unless the person is within 120 px of it
 *                                (default off, which is how every earlier run was made)
 */
export interface HarnessOptions {
  layout: RoomLayout;
  movement: MovementConfig;
  seatedFraction: number;
  walkToSeat: boolean;
}

export function parseHarnessOptions(env: Record<string, string | undefined>): HarnessOptions {
  const layoutId = env.LOAD_HARNESS_LAYOUT_ID ?? DEFAULT_LAYOUT_ID;
  const layout = resolveLayout(layoutId);
  if (!layout) {
    throw new Error(`Unknown layout "${layoutId}". Known layouts: ${listLayoutIds().join(", ")}`);
  }

  const raw = env.LOAD_HARNESS_SEATED_FRACTION;
  const seatedFraction = raw === undefined ? 0.5 : raw.trim() === "" ? Number.NaN : Number(raw);
  if (!Number.isFinite(seatedFraction) || seatedFraction < 0 || seatedFraction > 1) {
    throw new Error(`LOAD_HARNESS_SEATED_FRACTION must be a number between 0 and 1, got "${raw}"`);
  }

  return {
    layout,
    movement: movementConfigForLayout(layout, DEFAULT_MOVEMENT_CONFIG),
    seatedFraction,
    walkToSeat: env.LOAD_HARNESS_WALK_TO_SEAT === "1",
  };
}

/** How many people take a seat: the wanted share of n, but never more than the people who can
 *  sit (the idle canaries stay out) or the seats the layout has. */
export function seatTargetCount(n: number, candidates: number, seatsAvailable: number, fraction: number): number {
  return Math.min(candidates, Math.floor(n * fraction), seatsAvailable);
}
