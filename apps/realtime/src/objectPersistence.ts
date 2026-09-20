import type { ObjectState } from "@workspace-video/shared";

/** Thin repository seam over @workspace-video/db's object functions, so this module
 *  (and RoomManager, which owns it) can be unit-tested against an in-memory
 *  fake instead of a real Postgres connection. */
export interface ObjectRepository {
  loadRoomObjects(roomId: string): Promise<ObjectState[]>;
  upsertObject(state: ObjectState): Promise<void>;
  deleteObject(objectId: string): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 1000;

/**
 * Debounced write-behind persistence for canvas objects.
 *
 * INVARIANT (see the approved plan): one drag gesture must produce exactly
 * one durable write. A drag emits ~20 object:upsert events per second, each
 * of which is applied to in-memory room state and broadcast immediately —
 * but none of those events call into this module beyond `markDirty`, which
 * only records *that* an object changed, never *what* it changed to. The
 * actual value is read fresh from RoomManager (via the `getObject` callback)
 * only when the debounce timer actually fires, so a whole drag collapses
 * into a single UPDATE regardless of how many intermediate positions there
 * were.
 *
 * The debounce is a SELF-STOPPING setTimeout chain per room: scheduled the
 * moment a room first goes dirty, and not rescheduled again until the next
 * time something goes dirty after a flush — never a permanently-running
 * interval polling for work. This matches the same resource-lifecycle rule
 * already applied to the room tick timers (roomManager.ts) and the LiveKit
 * gain ramp (apps/web/src/audio/SpatialAudioController.ts).
 */
export class ObjectPersistence {
  private dirty = new Map<string, Set<string>>(); // roomId -> objectIds needing an upsert
  private deleted = new Map<string, Set<string>>(); // roomId -> objectIds needing a delete
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly repository: ObjectRepository,
    /** Reads the CURRENT authoritative state of one object from wherever it
     *  actually lives (RoomManager's in-memory map) — never a value cached
     *  at markDirty-time, which is what makes the "N edits -> 1 write"
     *  coalescing correct rather than just "N edits -> 1 write of a stale
     *  value". Returns undefined if the object (or room) no longer exists,
     *  in which case the pending upsert is simply skipped. */
    private readonly getObject: (roomId: string, objectId: string) => ObjectState | undefined,
    private readonly debounceMs: number = DEFAULT_DEBOUNCE_MS,
  ) {}

  /** Passthrough to the repository's load — exposed so RoomManager's
   *  hydrateObjects() doesn't need its own separate reference to the
   *  repository just to perform the one-time initial load. */
  loadRoomObjects(roomId: string) {
    return this.repository.loadRoomObjects(roomId);
  }

  markDirty(roomId: string, objectId: string): void {
    // An upsert supersedes any pending delete for the same id (e.g. a
    // delete was queued, then immediately undone/recreated before the
    // flush fired) — never leave both queued for the same object.
    this.deleted.get(roomId)?.delete(objectId);

    let set = this.dirty.get(roomId);
    if (!set) {
      set = new Set();
      this.dirty.set(roomId, set);
    }
    set.add(objectId);
    this.scheduleFlush(roomId);
  }

  markDeleted(roomId: string, objectId: string): void {
    this.dirty.get(roomId)?.delete(objectId);

    let set = this.deleted.get(roomId);
    if (!set) {
      set = new Set();
      this.deleted.set(roomId, set);
    }
    set.add(objectId);
    this.scheduleFlush(roomId);
  }

  private scheduleFlush(roomId: string): void {
    // Idempotent: a room that's already got a flush scheduled just picks up
    // the newly-dirty id when that timer fires — no second timer is armed.
    if (this.flushTimers.has(roomId)) return;

    const timer = setTimeout(() => {
      this.flushTimers.delete(roomId);
      void this.flushRoom(roomId);
    }, this.debounceMs);
    this.flushTimers.set(roomId, timer);
  }

  /** Flushes one room's pending dirty/deleted sets immediately, reading each
   *  dirty object's CURRENT value at call time. Safe to call redundantly
   *  (an empty room is a no-op) and safe to call while a timer for the same
   *  room is also pending (the caller is expected to have cancelled it
   *  first via flushAndClear when that matters). */
  async flushRoom(roomId: string): Promise<void> {
    const dirtyIds = this.dirty.get(roomId);
    const deletedIds = this.deleted.get(roomId);
    this.dirty.delete(roomId);
    this.deleted.delete(roomId);

    if (dirtyIds) {
      for (const objectId of dirtyIds) {
        const current = this.getObject(roomId, objectId);
        // Already gone (deleted after being marked dirty, or the room was
        // torn down) — nothing to write.
        if (current) await this.repository.upsertObject(current);
      }
    }
    if (deletedIds) {
      for (const objectId of deletedIds) {
        await this.repository.deleteObject(objectId);
      }
    }
  }

  /** Cancels a room's pending debounce timer (if any) and flushes it
   *  immediately. Call this on room eviction — BEFORE the room's in-memory
   *  state is discarded, since `getObject` needs it to still be reachable —
   *  so the last edit made just before everyone left isn't lost to the
   *  debounce window. */
  async flushAndClear(roomId: string): Promise<void> {
    const timer = this.flushTimers.get(roomId);
    if (timer) {
      clearTimeout(timer);
      this.flushTimers.delete(roomId);
    }
    await this.flushRoom(roomId);
  }

  /** Cancels every pending timer across every room and flushes each one.
   *  Call on process shutdown (SIGINT/SIGTERM) so a debounce window in
   *  progress at the moment of shutdown doesn't silently lose edits. */
  async flushAllAndDispose(): Promise<void> {
    const roomIds = new Set<string>([
      ...this.dirty.keys(),
      ...this.deleted.keys(),
      ...this.flushTimers.keys(),
    ]);

    for (const timer of this.flushTimers.values()) clearTimeout(timer);
    this.flushTimers.clear();

    for (const roomId of roomIds) {
      await this.flushRoom(roomId);
    }
  }

  /** True if a room has a flush timer currently scheduled — exposed only
   *  for tests asserting the self-stopping-loop invariant (no timer
   *  outlives a flush). */
  hasPendingFlush(roomId: string): boolean {
    return this.flushTimers.has(roomId);
  }
}

/** No-op repository used as RoomManager's default when a test/caller
 *  doesn't care about object persistence at all — matching the pattern of
 *  giving `leaseRefreshIntervalMs` a sensible default rather than requiring
 *  every call site to pass one. */
export const noopObjectRepository: ObjectRepository = {
  loadRoomObjects: async () => [],
  upsertObject: async () => {},
  deleteObject: async () => {},
};
