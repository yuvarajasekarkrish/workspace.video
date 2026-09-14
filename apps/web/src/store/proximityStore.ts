import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import type { DesiredAudioState, DesiredPeerAudio } from "@/audio/spatialAudio";

/**
 * Desired per-peer audio state, driven by `proximity:update` — the socket
 * event already emitted by the server (packages/shared/src/events.ts) and
 * already parsed by RealtimeClient, just never previously consumed.
 *
 * Same rule as peersStore: this is a VANILLA store, never subscribed to by a
 * React component. Because gain is a continuous function of distance on the
 * server (packages/proximity/src/proximity.ts), this can update at the full
 * 10Hz server tick rate while a peer is moving through the 200-500px band —
 * subscribing a component to it would violate the no-rerender rule the same
 * way a raw `peers` subscription would. SpatialAudioController is the only
 * reader, via `getState()` and `subscribe()` with an equality-gated selector.
 */
export interface ProximityState {
  desired: Map<string, DesiredPeerAudio>;

  /** Applied on every proximity:update for one peer. */
  setPeerProximity: (peerId: string, state: DesiredPeerAudio) => void;

  /** Applied on peers:snapshot — a wholesale roster replacement, so any
   *  cached desired-audio entry for a userId no longer in the roster must be
   *  dropped. Mirrors peersStore.applySnapshot's "replace, never merge" rule
   *  for the same reason: it's what prevents stale state surviving a reload
   *  or resync under a reused userId. */
  pruneToRoster: (activeUserIds: ReadonlySet<string>) => void;

  /** Applied on peers:delta's `left` list and on LiveKit's
   *  ParticipantDisconnected — either signal is sufficient to know a peer is
   *  gone and their desired audio state is stale. */
  removePeer: (userId: string) => void;

  clear: () => void;
}

export const proximityStore = createStore<ProximityState>()(
  subscribeWithSelector((set, get) => ({
    desired: new Map(),

    setPeerProximity: (peerId, state) => {
      const next = new Map(get().desired);
      next.set(peerId, state);
      set({ desired: next });
    },

    pruneToRoster: (activeUserIds) => {
      const previous = get().desired;
      let changed = false;
      const next = new Map<string, DesiredPeerAudio>();
      for (const [userId, state] of previous) {
        if (activeUserIds.has(userId)) {
          next.set(userId, state);
        } else {
          changed = true;
        }
      }
      if (changed) set({ desired: next });
    },

    removePeer: (userId) => {
      if (!get().desired.has(userId)) return;
      const next = new Map(get().desired);
      next.delete(userId);
      set({ desired: next });
    },

    clear: () => set({ desired: new Map() }),
  })),
);

/** Read-only view for consumers (SpatialAudioController) that only need the
 *  map, typed as the plain DesiredAudioState the pure core in
 *  spatialAudio.ts expects — decouples that module from Zustand entirely. */
export function getDesiredAudioState(): DesiredAudioState {
  return proximityStore.getState().desired;
}
