import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

/**
 * The LOCAL user's proximity to a labeled seat that has no owning zone (e.g.
 * a hot-desk — see the deskGrid module, which never pushes a LayoutZone).
 * Deliberately independent of zoneStore/the server's zone:changed event: a
 * desk's name is cosmetic-only, so this never touches the zone-audio /
 * zoneRecheckCounterparts machinery those events are wired into (see the
 * eng-review notes on that cost). PixiStage's ticker computes this from the
 * local avatar's renderPosition each frame (matching the existing per-frame
 * proximity pattern) but only calls `set`/`clear` when the nearby seat's id
 * actually changes — so, like zoneStore, this plain store never fires a
 * subscriber on every frame even though its INPUT changes every frame.
 */
export interface NearbySeat {
  seatId: string;
  label: string;
}

export interface NearbySeatState {
  current: NearbySeat | null;
  set: (seat: NearbySeat | null) => void;
}

export const nearbySeatStore = createStore<NearbySeatState>()((set) => ({
  current: null,
  set: (seat) => set({ current: seat }),
}));

export function useNearbySeat(): NearbySeat | null {
  return useStore(nearbySeatStore, (s) => s.current);
}
