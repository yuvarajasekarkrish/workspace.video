import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

/**
 * Live "N / limit people online" for the room's workspace. Updated from
 * peers:snapshot (which carries active/limit alongside the roster on every
 * join) and occupancy:update (broadcast on leave — see RealtimeClient and
 * apps/realtime/src/roomManager.ts's admitAndAddPeer/removePeer).
 *
 * Changes on join/leave only, never on movement, so — like connectionStore —
 * this is a plain React-subscribable store rather than the
 * read-outside-React pattern peersStore/objectsStore use for position data.
 */
export interface OccupancyState {
  active: number;
  limit: number;
  setOccupancy: (active: number, limit: number) => void;
  clear: () => void;
}

export const occupancyStore = createStore<OccupancyState>()((set) => ({
  active: 0,
  limit: 0,
  setOccupancy: (active, limit) => set({ active, limit }),
  clear: () => set({ active: 0, limit: 0 }),
}));

export function useOccupancy(): { active: number; limit: number } {
  // No selector: the store already only changes shape on setOccupancy/clear,
  // so subscribing to the whole (small) state avoids allocating a new object
  // on every read the way a `(s) => ({...})` selector would.
  const { active, limit } = useStore(occupancyStore);
  return { active, limit };
}
