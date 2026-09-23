import type { RoomLayout } from "./types";
import { openOffice1 } from "./openOffice";
import { spatialMap1 } from "./mapLayout";
import { office300 } from "./office300";

export const DEFAULT_LAYOUT_ID = "openOffice@1";

const LAYOUT_REGISTRY: Record<string, RoomLayout> = {
  [openOffice1.id]: openOffice1,
  [spatialMap1.id]: spatialMap1,
  [office300.id]: office300,
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
