import type { RoomLayout } from "./types";
import { office300 } from "./office300";
import { cosmicCampus100 } from "./cosmicCampus100";

export const DEFAULT_LAYOUT_ID = "office300@1";

const LAYOUT_REGISTRY: Record<string, RoomLayout> = {
  [office300.id]: office300,
  [cosmicCampus100.id]: cosmicCampus100,
};

/** Human names for the template picker. */
export const LAYOUT_LABELS: Record<string, string> = {
  [office300.id]: "Office — 300",
  [cosmicCampus100.id]: "Cosmic Campus — 100",
};

/** Returns `null` for an unknown id rather than throwing — callers (see
 *  parseRoomConfig in queries.ts) are expected to fall back to the default
 *  layout rather than let a stale/typo'd Room.config brick a room. */
export function resolveLayout(layoutId: string): RoomLayout | null {
  return LAYOUT_REGISTRY[layoutId] ?? null;
}

export function listLayoutIds(): string[] {
  return Object.keys(LAYOUT_REGISTRY);
}
