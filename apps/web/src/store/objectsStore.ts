import { createStore } from "zustand/vanilla";
import { subscribeWithSelector } from "zustand/middleware";
import { useRef, useCallback, useSyncExternalStore } from "react";
import type { ObjectState } from "@workspace-video/shared";

/**
 * Canvas object state, read entirely outside React — the object-editing
 * counterpart of peersStore.ts, following the identical shape for the
 * identical reason.
 *
 * THE HARD RULE still holds: React must never re-render on a drag/resize.
 * This is a vanilla Zustand store; the Pixi ticker reads
 * `objectsStore.getState()` directly every frame, and the only thing React
 * may subscribe to is selection identity (which object, if any, is
 * selected) via `useSelectedObject()` below — never coordinates.
 *
 * Two coordinate-ish fields per object, mirroring peersStore's
 * position/renderPosition split:
 *   - the top-level x/y/width/height (from ObjectState) — the last
 *     authoritative value from the server (the interpolation *target*).
 *   - `render`      — what's actually drawn. The Pixi ticker advances this
 *                      toward the authoritative rect every frame for a
 *                      REMOTE edit, mutated in place (never via `set()`) for
 *                      allocation-free, subscriber-silent updates. For an
 *                      object the LOCAL user is actively dragging, `render`
 *                      instead tracks the pointer immediately — see
 *                      `locallyDirty` below.
 */
export interface ObjectRender {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ObjectRecord {
  state: ObjectState;
  render: ObjectRender;
  /** True while we have an optimistic local edit in flight (dragging,
   *  resizing, or just-submitted-and-not-yet-acked). While true, an
   *  incoming object:sync updates `state` (so baseVersion tracking stays
   *  correct) but must NOT overwrite `render` — otherwise the object you're
   *  dragging would visibly jump back toward the last server-acked position
   *  on every round trip, fighting your own cursor. */
  locallyDirty: boolean;
}

export interface ObjectsState {
  objects: Map<string, ObjectRecord>;
  selectedId: string | null;

  /** Wholesale replacement — the only correct response to objects:snapshot,
   *  for the identical reason peers:snapshot is: it's what prevents a
   *  ghost/stale object surviving a reconnect. Preserves `render` and
   *  `locallyDirty` for surviving ids so a resync doesn't cause a visible
   *  snap for an object nobody's touching. */
  applySnapshot: (objects: ObjectState[]) => void;

  /** Applied on object:sync. `accepted: true` always updates `state` (and,
   *  unless locallyDirty, `render`). `accepted: false` snaps `render` back
   *  to the authoritative rect regardless of locallyDirty — a rejection
   *  means OUR optimistic edit was wrong, so it must not keep tracking the
   *  pointer as if it were still pending. */
  applySync: (object: ObjectState, accepted: boolean) => void;

  applyRemoved: (objectId: string) => void;

  /** Optimistic local edit (drag/resize in progress or a fresh create).
   *  Updates `render` immediately and marks the object dirty; does NOT
   *  touch `state.version` — that only ever changes via applySync. */
  applyLocalEdit: (objectId: string, rect: ObjectRender) => void;

  /** Registers a brand-new object created locally, before the server has
   *  acked it — same "optimistic, corrected later" shape create/edit share
   *  via baseVersion 0 in the wire event. */
  addOptimistic: (object: ObjectState) => void;

  /** Clears locallyDirty once a drag/resize gesture ends and its final
   *  value has been acked (or the gesture is abandoned) — render then goes
   *  back to converging toward `state` like any other object. */
  clearLocallyDirty: (objectId: string) => void;

  setSelected: (objectId: string | null) => void;

  clear: () => void;
}

function toRender(state: ObjectState): ObjectRender {
  return { x: state.x, y: state.y, width: state.width, height: state.height };
}

export const objectsStore = createStore<ObjectsState>()(
  subscribeWithSelector((set, get) => ({
    objects: new Map(),
    selectedId: null,

    applySnapshot: (incoming) => {
      const previous = get().objects;
      const next = new Map<string, ObjectRecord>();

      for (const state of incoming) {
        const existing = previous.get(state.objectId);
        next.set(state.objectId, {
          state,
          render: existing ? existing.render : toRender(state),
          locallyDirty: existing?.locallyDirty ?? false,
        });
      }

      // Deselect if the selected object no longer exists after the resync.
      const selectedId = get().selectedId;
      const stillSelected = selectedId !== null && next.has(selectedId);
      set({ objects: next, selectedId: stillSelected ? selectedId : null });
    },

    applySync: (object, accepted) => {
      const objects = new Map(get().objects);
      const existing = objects.get(object.objectId);

      objects.set(object.objectId, {
        state: object,
        render: accepted && existing?.locallyDirty ? existing.render : toRender(object),
        locallyDirty: accepted ? (existing?.locallyDirty ?? false) : false,
      });
      set({ objects });
    },

    applyRemoved: (objectId) => {
      if (!get().objects.has(objectId)) return;
      const objects = new Map(get().objects);
      objects.delete(objectId);
      const selectedId = get().selectedId === objectId ? null : get().selectedId;
      set({ objects, selectedId });
    },

    applyLocalEdit: (objectId, rect) => {
      const objects = get().objects;
      const existing = objects.get(objectId);
      if (!existing) return;
      // Mutate render in place — same allocation-free, subscriber-silent
      // trick peersStore.renderPosition uses; this must never go through
      // set() or every drag frame would notify subscribers.
      existing.render.x = rect.x;
      existing.render.y = rect.y;
      existing.render.width = rect.width;
      existing.render.height = rect.height;
      existing.locallyDirty = true;
    },

    addOptimistic: (object) => {
      const objects = new Map(get().objects);
      objects.set(object.objectId, { state: object, render: toRender(object), locallyDirty: true });
      set({ objects, selectedId: object.objectId });
    },

    clearLocallyDirty: (objectId) => {
      const existing = get().objects.get(objectId);
      if (existing) existing.locallyDirty = false;
    },

    setSelected: (objectId) => set({ selectedId: objectId }),

    clear: () => set({ objects: new Map(), selectedId: null }),
  })),
);

// ---------------------------------------------------------------------------
// React-safe selectors
// ---------------------------------------------------------------------------

export interface SelectedObjectInfo {
  objectId: string;
  type: ObjectState["type"];
  isCreator: boolean;
}

function selectSelected(localUserId: string) {
  return (state: ObjectsState): SelectedObjectInfo | null => {
    if (!state.selectedId) return null;
    const record = state.objects.get(state.selectedId);
    if (!record) return null;
    return {
      objectId: record.state.objectId,
      type: record.state.type,
      isCreator: record.state.createdById === localUserId,
    };
  };
}

function selectedEquals(a: SelectedObjectInfo | null, b: SelectedObjectInfo | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.objectId === b.objectId && a.type === b.type && a.isCreator === b.isCreator;
}

/** The React-safe way to read the current selection. Same
 *  useSyncExternalStore + subscribeWithSelector's equalityFn pattern as
 *  peersStore's useRoster (see that file for why: Zustand v5's `useStore`
 *  has no equality-function parameter, and a naive selector re-allocates on
 *  every store change, which here happens up to 20x/second during a drag). */
export function useSelectedObject(localUserId: string): SelectedObjectInfo | null {
  const selector = useCallback(selectSelected(localUserId), [localUserId]);
  const cached = useRef<SelectedObjectInfo | null>(selector(objectsStore.getState()));

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      objectsStore.subscribe(
        selector,
        (next) => {
          cached.current = next;
          onStoreChange();
        },
        { equalityFn: selectedEquals },
      ),
    [selector],
  );

  const getSnapshot = useCallback(() => cached.current, []);
  const getServerSnapshot = useCallback(() => null, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

function selectCount(state: ObjectsState): number {
  return state.objects.size;
}

/** Object count changes on human timescales (create/delete), never on
 *  drag/resize, so a plain equality check on the number is enough — no
 *  custom equalityFn needed beyond useSyncExternalStore's default
 *  Object.is, since selectCount already returns a primitive. */
export function useObjectCount(): number {
  const subscribe = useCallback(
    (onStoreChange: () => void) => objectsStore.subscribe(selectCount, onStoreChange),
    [],
  );
  const getSnapshot = useCallback(() => selectCount(objectsStore.getState()), []);
  const getServerSnapshot = useCallback(() => 0, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
