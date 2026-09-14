import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { useRef, useCallback, useSyncExternalStore } from "react";
import type { Point } from "@cosmos/shared";

/**
 * Roster + position state, read entirely outside React.
 *
 * THE HARD RULE: React must never re-render on movement. This store is a
 * vanilla Zustand store (createStore, not the `create` React hook) precisely
 * so nothing here can be wired to a React re-render by accident — the Pixi
 * ticker reads `peersStore.getState()` directly every frame, and anything
 * that *does* need to be a React hook (e.g. a roster list in the HUD) must
 * subscribe with a selector that only changes on roster identity (who's
 * here, names), never on `position`/`renderPosition`, which change up to
 * every 100ms per peer.
 *
 * Two coordinate fields per peer, matching canvas/interpolation.ts:
 *   - `position`      — last authoritative value from the server (the
 *                        interpolation *target*).
 *   - `renderPosition` — what's actually drawn; the Pixi ticker advances
 *                        this toward `position` every frame. Mutated
 *                        in-place by the ticker (see canvas/Avatar.ts) for
 *                        allocation-free per-frame updates — never write to
 *                        it via `store.setState`, which would trigger
 *                        subscriber notifications every ticker frame.
 */
export interface PeerRecord {
  userId: string;
  name: string;
  avatarUrl: string | null;
  position: Point;
  renderPosition: Point;
  isLocal: boolean;
}

export interface PeersState {
  peers: Map<string, PeerRecord>;
  localUserId: string | null;

  /** Wholesale roster replacement — the only correct response to
   *  peers:snapshot. Preserves each surviving peer's `renderPosition` (and
   *  in-flight interpolation) rather than resetting it, so a resync doesn't
   *  cause a visible snap even though `position` targets are refreshed. */
  applySnapshot: (localUserId: string, incoming: { userId: string; name: string; avatarUrl: string | null; position: Point }[]) => void;

  /** Incremental position update from peers:delta. Never touches identity
   *  fields, and never touches peers not present in `updates`/`left`. */
  applyDelta: (updates: { userId: string; position: Point }[], left: string[]) => void;

  /** Local-only immediate position write (from input), independent of the
   *  server round trip. */
  setLocalPosition: (position: Point) => void;

  clear: () => void;
}

export const peersStore = createStore<PeersState>()(
  subscribeWithSelector((set, get) => ({
    peers: new Map(),
    localUserId: null,

    applySnapshot: (localUserId, incoming) => {
      const previous = get().peers;
      const next = new Map<string, PeerRecord>();

      for (const p of incoming) {
        const existing = previous.get(p.userId);
        next.set(p.userId, {
          userId: p.userId,
          name: p.name,
          avatarUrl: p.avatarUrl,
          position: p.position,
          // Keep mid-flight render position if we already had this peer
          // (avoids a visual snap on resync); otherwise start settled at
          // the authoritative position.
          renderPosition: existing ? existing.renderPosition : { ...p.position },
          isLocal: p.userId === localUserId,
        });
      }

      set({ peers: next, localUserId });
    },

    applyDelta: (updates, left) => {
      const peers = new Map(get().peers);

      for (const { userId, position } of updates) {
        const existing = peers.get(userId);
        if (!existing) continue; // unknown peer — wait for the next snapshot rather than fabricate one
        peers.set(userId, { ...existing, position });
      }

      for (const userId of left) {
        peers.delete(userId);
      }

      set({ peers });
    },

    setLocalPosition: (position) => {
      const { localUserId, peers } = get();
      if (!localUserId) return;
      const existing = peers.get(localUserId);
      if (!existing) return;

      const next = new Map(peers);
      next.set(localUserId, { ...existing, position, renderPosition: { ...position } });
      set({ peers: next });
    },

    clear: () => set({ peers: new Map(), localUserId: null }),
  })),
);

// ---------------------------------------------------------------------------
// React-safe selectors
// ---------------------------------------------------------------------------

/** Roster identity only — userId/name/avatarUrl/isLocal, deliberately
 *  excluding position/renderPosition. `applyDelta` creates a new `peers` Map
 *  on every ~100ms server tick even when only positions changed, so a naive
 *  `peers` subscription would re-render a React component 10x/second. Any
 *  React component that needs "who's here" (a roster HUD, participant list)
 *  must go through this selector paired with `rosterEquals` below, never
 *  subscribe to `state.peers` directly. */
export interface RosterEntry {
  userId: string;
  name: string;
  avatarUrl: string | null;
  isLocal: boolean;
}

export function selectRoster(state: PeersState): RosterEntry[] {
  return Array.from(state.peers.values())
    .map(({ userId, name, avatarUrl, isLocal }) => ({ userId, name, avatarUrl, isLocal }))
    .sort((a, b) => a.userId.localeCompare(b.userId));
}

/** Equality check for `selectRoster`'s output — compares identity fields
 *  only, so a same-membership roster with different positions is treated
 *  as equal and does not trigger a re-render. */
export function rosterEquals(a: RosterEntry[], b: RosterEntry[]): boolean {
  if (a.length !== b.length) return false;
  return a.every(
    (entry, i) =>
      entry.userId === b[i]!.userId &&
      entry.name === b[i]!.name &&
      entry.avatarUrl === b[i]!.avatarUrl &&
      entry.isLocal === b[i]!.isLocal,
  );
}

/**
 * The React-safe way to read the roster. Zustand v5's `useStore` hook has
 * no equality-function parameter (unlike v4) — passing one is silently
 * ignored, and `selectRoster` allocates a new array on every store change,
 * so a plain `useStore(peersStore, selectRoster)` would re-render on every
 * ~100ms position tick regardless. Instead this uses the store's own
 * `subscribeWithSelector`-provided `equalityFn` option (which controls
 * whether the listener fires at all) to gate a `useSyncExternalStore`
 * snapshot, so React only re-renders when roster identity actually changes.
 */
const EMPTY_ROSTER: RosterEntry[] = [];

export function useRoster(): RosterEntry[] {
  const cached = useRef<RosterEntry[]>(selectRoster(peersStore.getState()));

  const subscribe = useCallback((onStoreChange: () => void) => {
    return peersStore.subscribe(
      selectRoster,
      (next) => {
        cached.current = next;
        onStoreChange();
      },
      { equalityFn: rosterEquals },
    );
  }, []);

  const getSnapshot = useCallback(() => cached.current, []);
  // The server never has live peers (the socket only connects client-side),
  // so the SSR/initial-render snapshot is always the empty roster — a
  // stable module-level reference so React doesn't see it as "changed" on
  // every server render.
  const getServerSnapshot = useCallback(() => EMPTY_ROSTER, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
