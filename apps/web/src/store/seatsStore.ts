import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { useRef, useCallback, useSyncExternalStore } from "react";

/**
 * Hot-desk seat occupancy — who is sitting where, for every peer in the
 * room. Read entirely outside React by PixiStage (to tint occupied chairs
 * and draw a seated ring on the owning avatar), mirroring peersStore's
 * "vanilla store, imperative reads" shape. Occupancy changes at join/leave
 * frequency (human timescale), never per frame, so unlike peersStore's
 * position data there is no allocation-free in-place-mutation concern here
 * — a plain `set()` per change is fine.
 *
 * IMPORTANT ownership boundary: this store is occupancy ONLY — it drives
 * other users' seated visuals and the seat/chair tint. It does NOT own
 * whether the LOCAL user is seated; that flag lives on MovementController
 * (see input/MovementController.ts's `seated`), set only by local intent
 * (a claim ack) or local action (a movement key). A `seat:update` echo for
 * our own seat arriving here after we've already stood up locally must
 * never resurrect MovementController's `seated` flag — and since nothing
 * in this store ever reaches into MovementController, that's true by
 * construction, not by a check either side has to remember to make.
 */
export interface SeatsState {
  /** seatId -> occupant userId. */
  occupancy: Map<string, string>;

  /** Wholesale replacement — the only correct response to seats:snapshot,
   *  for the identical reason peers:snapshot/objects:snapshot are. */
  applySnapshot: (entries: { seatId: string; userId: string }[]) => void;

  /** Applied on seat:update. `userId: null` frees the seat. */
  applyUpdate: (seatId: string, userId: string | null) => void;

  clear: () => void;
}

export const seatsStore = createStore<SeatsState>()(
  subscribeWithSelector((set) => ({
    occupancy: new Map(),

    applySnapshot: (entries) => {
      set({ occupancy: new Map(entries.map((e) => [e.seatId, e.userId])) });
    },

    applyUpdate: (seatId, userId) => {
      set((state) => {
        const next = new Map(state.occupancy);
        if (userId === null) {
          next.delete(seatId);
        } else {
          next.set(seatId, userId);
        }
        return { occupancy: next };
      });
    },

    clear: () => set({ occupancy: new Map() }),
  })),
);

/** Which seat (if any) `userId` currently occupies — a small linear scan
 *  over occupancy, which at real-world seat counts (hundreds, not millions)
 *  is cheaper than maintaining a second reverse-index Map client-side for
 *  something read only on human-timescale events (HUD labels, not every
 *  frame). */
export function seatOf(occupancy: Map<string, string>, userId: string): string | null {
  for (const [seatId, occupant] of occupancy) {
    if (occupant === userId) return seatId;
  }
  return null;
}

/** React-safe selector for "which seat is this user in" (e.g. a roster
 *  label) — re-renders only when THIS user's seat identity actually
 *  changes, not on every occupancy update elsewhere in the room. Follows
 *  the same useSyncExternalStore + cached-snapshot pattern as
 *  peersStore.useRoster / objectsStore.useSelectedObject. */
export function useSeatOf(userId: string | null): string | null {
  const cached = useRef<string | null>(userId ? seatOf(seatsStore.getState().occupancy, userId) : null);

  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!userId) return () => {};
      return seatsStore.subscribe(
        (state) => seatOf(state.occupancy, userId),
        (next) => {
          cached.current = next;
          onStoreChange();
        },
      );
    },
    [userId],
  );

  const getSnapshot = useCallback(() => cached.current, []);
  const getServerSnapshot = useCallback(() => null, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
