import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";
import type { ZoneChangedEvent } from "@cosmos/shared";

/**
 * The LOCAL user's own current zone (meeting room, cabin, stage, audience,
 * open area, or focus zone) — changes at human timescale (crossing a
 * boundary), never per frame, so — like connectionStore/occupancyStore —
 * this is a plain React-subscribable store, not the read-outside-React
 * pattern peersStore/objectsStore use for position data.
 *
 * Driven entirely by the server's zone:changed event (see RealtimeClient) —
 * this store has no notion of "which zone am I in" beyond what the server
 * told it, since zone membership is a server-authoritative computation
 * (packages/proximity's zoneAudio.ts + RoomManager's tick()), not something
 * the client derives for itself.
 */
export type CurrentZone = NonNullable<ZoneChangedEvent["zone"]>;

export interface ZoneState {
  current: CurrentZone | null;
  /** The zone just left, kept only long enough for the toast to describe
   *  "Left X" — cleared implicitly by the next zone:changed (it always
   *  becomes the new `previous`). */
  previous: CurrentZone | null;
  setZone: (zone: CurrentZone | null) => void;
  clear: () => void;
}

export const zoneStore = createStore<ZoneState>()((set, get) => ({
  current: null,
  previous: null,
  setZone: (zone) => set({ current: zone, previous: get().current }),
  clear: () => set({ current: null, previous: null }),
}));

export function useZoneStore<T>(selector: (state: ZoneState) => T): T {
  return useStore(zoneStore, selector);
}
