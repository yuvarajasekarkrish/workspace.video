import type { Server as SocketIOServer } from "socket.io";
import type { Point, ObjectState } from "@cosmos/shared";
import { ServerEvents, DEFAULT_MOVEMENT_CONFIG, DEFAULT_PROXIMITY_CONFIG } from "@cosmos/shared";
import type { RoomLease } from "@cosmos/realtime-core";
import {
  validateMove,
  tickProximity,
  pairKey,
  resolveObjectWrite,
  resolveObjectDelete,
  type ProximityState,
  type ProposedObjectWrite,
  type ObjectWriteResult,
  type ObjectDeleteOutcome,
} from "@cosmos/proximity";
import { ObjectPersistence, noopObjectRepository, type ObjectRepository } from "./objectPersistence";

/** Hard cap on objects per room, checked before accepting a create — bounds
 *  the worst case for both realtime-process memory and the objects table. */
const MAX_OBJECTS_PER_ROOM = 2000;

export type ObjectUpsertOutcome = ObjectWriteResult | { accepted: false; reason: "room_full"; authoritative: null };

/** Minimal emitter surface RoomManager needs from Socket.IO — narrowed so
 *  unit tests can pass a lightweight fake instead of a real server. */
export interface RoomBroadcaster {
  to(room: string): { emit(event: string, payload: unknown): void };
  disconnectSocketsInRoom(roomId: string): void;
}

export function broadcasterFromSocketServer(io: SocketIOServer): RoomBroadcaster {
  return {
    to: (room) => io.to(room),
    disconnectSocketsInRoom: (roomId) => {
      for (const [, socket] of io.sockets.sockets) {
        if (socket.rooms.has(roomId)) socket.disconnect(true);
      }
    },
  };
}

interface PeerState {
  userId: string;
  name: string;
  avatarUrl: string | null;
  socketId: string;
  position: Point;
  acceptedAtMs: number;
}

/**
 * Authoritative, in-memory state for every room this instance currently owns
 * the lease for. Deliberately not backed by Redis on the hot path — see the
 * plan's "Redis is not in the per-movement path" decision. One RoomManager
 * per realtime process; rooms this instance does not own simply never appear
 * here (join is refused before a room's state would be created — see server.ts).
 */
export class RoomManager {
  private rooms = new Map<
    string,
    {
      peers: Map<string, PeerState>; // keyed by userId
      proximityStates: Map<string, ProximityState>; // keyed by pairKey(a,b)
      objects: Map<string, ObjectState>; // keyed by objectId
      /** Memoized load-from-Postgres promise, set the first time
       *  hydrateObjects() is called for this room and never cleared —
       *  concurrent joins all await the SAME promise instead of triggering
       *  a duplicate load, and later joins get the already-resolved one
       *  back instantly. See hydrateObjects() below. */
      objectsHydration: Promise<void> | null;
      tickTimer: NodeJS.Timeout;
      leaseRefreshTimer: NodeJS.Timeout;
    }
  >();

  private readonly objectPersistence: ObjectPersistence;

  constructor(
    private readonly broadcaster: RoomBroadcaster,
    private readonly lease: RoomLease,
    private readonly instanceId: string,
    private readonly leaseRefreshIntervalMs = 10_000,
    objectRepository: ObjectRepository = noopObjectRepository,
  ) {
    // Owned internally (not injected as a whole) because it needs a
    // `getObject` closure over this.rooms — constructing it here, rather
    // than requiring a caller to somehow close over a not-yet-constructed
    // RoomManager, is what breaks that circularity. Only the DB-facing
    // repository is injected, which is also all a test needs to fake.
    this.objectPersistence = new ObjectPersistence(
      objectRepository,
      (roomId, objectId) => this.rooms.get(roomId)?.objects.get(objectId),
    );
  }

  /** Called once this instance has confirmed (via the lease) that it owns
   *  `roomId`. Idempotent — safe to call on every join. Deliberately
   *  synchronous: it only allocates in-memory room state. Loading
   *  persisted objects is a separate async step — see hydrateObjects(). */
  ensureRoom(roomId: string): void {
    if (this.rooms.has(roomId)) return;

    const tickTimer = setInterval(
      () => this.tick(roomId),
      DEFAULT_PROXIMITY_CONFIG.tickIntervalMs,
    );

    // Refresh the lease well inside its TTL. If refresh ever fails, this
    // instance has lost ownership (another instance's claim won a race after
    // this one's lease lapsed) — evict all local state and boot connected
    // clients back to endpoint resolution rather than keep serving stale state.
    const leaseRefreshTimer = setInterval(async () => {
      const stillOwner = await this.lease.refresh(this.instanceId, roomId);
      if (!stillOwner) {
        await this.evictRoom(roomId, { notifyOwnerChanged: true });
      }
    }, this.leaseRefreshIntervalMs);

    this.rooms.set(roomId, {
      peers: new Map(),
      proximityStates: new Map(),
      objects: new Map(),
      objectsHydration: null,
      tickTimer,
      leaseRefreshTimer,
    });
  }

  /** Loads this room's persisted objects from Postgres into memory, exactly
   *  once per room's lifetime (until eviction). Must be awaited by the
   *  caller (server.ts) before processing ANY object read/mutation for the
   *  room — including the very join that triggers it, since the joining
   *  client needs the loaded objects for its objects:snapshot. Concurrent
   *  joins for the same room all await the same in-flight promise rather
   *  than racing separate loads. */
  async hydrateObjects(roomId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    if (room.objectsHydration) return room.objectsHydration;

    room.objectsHydration = (async () => {
      const persisted = await this.objectPersistence.loadRoomObjects(roomId);
      for (const obj of persisted) {
        room.objects.set(obj.objectId, obj);
      }
    })();
    return room.objectsHydration;
  }

  addPeer(roomId: string, peer: Omit<PeerState, "acceptedAtMs">): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.peers.set(peer.userId, { ...peer, acceptedAtMs: Date.now() });
  }

  /** Returns a Promise (rather than being fire-and-forget) so callers that
   *  care about eviction actually completing — including a pending object
   *  flush — can await it; server.ts's disconnect handler does not need to
   *  and does not. */
  async removePeer(roomId: string, userId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.peers.delete(userId);

    // Prune every cached pair-proximity state involving the departing peer.
    // Without this, a rejoining user with the same userId (e.g. after a
    // reload) recomputes an IDENTICAL proximity state against a peer who
    // never left, so tickProximity's change-detection sees no diff and never
    // re-emits proximity:update — the rejoining client silently never learns
    // to subscribe to that peer's audio. Also a straight memory leak: this
    // map otherwise only grows for the lifetime of the room.
    for (const key of room.proximityStates.keys()) {
      if (key.startsWith(`${userId}:`) || key.endsWith(`:${userId}`)) {
        room.proximityStates.delete(key);
      }
    }

    this.broadcaster.to(roomId).emit(ServerEvents.PeersDelta, { roomId, updates: [], left: [userId] });

    if (room.peers.size === 0) {
      await this.evictRoom(roomId, { notifyOwnerChanged: false });
    }
  }

  snapshot(roomId: string) {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.peers.values()).map((p) => ({
      userId: p.userId,
      name: p.name,
      avatarUrl: p.avatarUrl,
      position: p.position,
    }));
  }

  /** Applies a client's proposed move. Returns whether it was accepted; on
   *  rejection the caller (server.ts) sends the client a correction. */
  applyMove(
    roomId: string,
    userId: string,
    proposed: Point,
  ): ReturnType<typeof validateMove> | undefined {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(userId);
    if (!room || !peer) return undefined;

    const result = validateMove(
      proposed,
      { position: peer.position, acceptedAtMs: peer.acceptedAtMs },
      Date.now(),
      DEFAULT_MOVEMENT_CONFIG,
    );

    if (result.accepted) {
      peer.position = result.position;
      peer.acceptedAtMs = Date.now();
    }

    return result;
  }

  /** Every object currently held for a room, sent to a joining/reconnecting
   *  client as objects:snapshot. Unlike peers:snapshot, this is never
   *  broadcast to the whole room on a join — an existing peer's knowledge
   *  of the room's objects doesn't change just because someone else joined,
   *  whereas peers:snapshot also doubles as how existing peers learn the
   *  newcomer's identity. Requires hydrateObjects() to have been awaited
   *  first, or this simply returns whatever (possibly nothing) has loaded
   *  so far — server.ts always awaits hydration before calling this. */
  objectsSnapshot(roomId: string): ObjectState[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.objects.values());
  }

  /** Applies a client's proposed object create/edit. Delegates the actual
   *  accept/reject decision to the pure resolveObjectWrite (LWW by
   *  version), after first enforcing the per-room object cap — a cap
   *  concern belongs at the room level, not in the pure version-resolution
   *  logic, so it's checked here rather than folded into objectLww.ts. */
  applyObjectUpsert(
    roomId: string,
    actorUserId: string,
    proposed: ProposedObjectWrite,
  ): ObjectUpsertOutcome | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;

    const current = room.objects.get(proposed.objectId);
    if (!current && room.objects.size >= MAX_OBJECTS_PER_ROOM) {
      return { accepted: false, reason: "room_full", authoritative: null };
    }

    const result = resolveObjectWrite(proposed, current, actorUserId);
    if (result.accepted) {
      room.objects.set(proposed.objectId, result.next);
      this.objectPersistence.markDirty(roomId, proposed.objectId);
    }
    return result;
  }

  /** Applies a client's proposed object delete. Creator-only, enforced by
   *  resolveObjectDelete — the server is the boundary, not just the UI. */
  applyObjectDelete(
    roomId: string,
    actorUserId: string,
    objectId: string,
    baseVersion: number,
  ): ObjectDeleteOutcome | undefined {
    const room = this.rooms.get(roomId);
    if (!room) return undefined;

    const current = room.objects.get(objectId);
    const outcome = resolveObjectDelete(objectId, baseVersion, current, actorUserId);
    if (outcome.outcome === "deleted") {
      room.objects.delete(objectId);
      this.objectPersistence.markDeleted(roomId, objectId);
    }
    return outcome;
  }

  private lastEmittedPositions = new Map<string, Map<string, Point>>();

  /** Exposed for tests to drive the tick deterministically instead of
   *  waiting on the real setInterval; production code never calls this
   *  directly (ensureRoom's timer does). */
  runTickForTest(roomId: string): void {
    this.tick(roomId);
  }

  private tick(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room || room.peers.size === 0) return;

    // Batched position delta: only peers whose position changed since the
    // last tick, per the 100ms-batch contract in packages/shared/events.ts.
    const lastPositions = this.lastEmittedPositions.get(roomId) ?? new Map<string, Point>();
    const updates: { userId: string; position: Point }[] = [];
    const currentPositions = new Map<string, Point>();

    for (const peer of room.peers.values()) {
      currentPositions.set(peer.userId, peer.position);
      const last = lastPositions.get(peer.userId);
      if (!last || last.x !== peer.position.x || last.y !== peer.position.y) {
        updates.push({ userId: peer.userId, position: peer.position });
      }
    }
    this.lastEmittedPositions.set(roomId, currentPositions);

    if (updates.length > 0) {
      this.broadcaster.to(roomId).emit(ServerEvents.PeersDelta, { roomId, updates, left: [] });
    }

    // Proximity: recompute over current positions, diff against last known
    // pair states, and push only pairs whose state actually changed.
    const changes = tickProximity(currentPositions, room.proximityStates, DEFAULT_PROXIMITY_CONFIG);
    for (const change of changes) {
      room.proximityStates.set(pairKey(change.a, change.b), change.state);

      const socketA = room.peers.get(change.a)?.socketId;
      const socketB = room.peers.get(change.b)?.socketId;
      if (socketA) {
        this.broadcaster.to(socketA).emit(ServerEvents.ProximityUpdate, {
          peerId: change.b,
          ...change.state,
        });
      }
      if (socketB) {
        this.broadcaster.to(socketB).emit(ServerEvents.ProximityUpdate, {
          peerId: change.a,
          ...change.state,
        });
      }
    }
  }

  private async evictRoom(roomId: string, opts: { notifyOwnerChanged: boolean }): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;

    clearInterval(room.tickTimer);
    clearInterval(room.leaseRefreshTimer);
    this.lastEmittedPositions.delete(roomId);

    // Flush any pending object writes BEFORE dropping the room from
    // `this.rooms` — flushAndClear's writes read fresh values via the
    // objectPersistence's getObject closure, which resolves through
    // `this.rooms.get(roomId)`; deleting the entry first would make every
    // pending write silently no-op, losing the last edit made just before
    // everyone left the room.
    await this.objectPersistence.flushAndClear(roomId);

    if (opts.notifyOwnerChanged) {
      // Tell every socket in the room to re-resolve its endpoint rather than
      // keep talking to an instance that is no longer authoritative for it —
      // this is what prevents a split room during a failover window.
      this.broadcaster.to(roomId).emit(ServerEvents.OwnerChanged, { roomId });
      this.broadcaster.disconnectSocketsInRoom(roomId);
    }

    this.rooms.delete(roomId);
  }

  isOwnedLocally(roomId: string): boolean {
    return this.rooms.has(roomId);
  }

  /** Clears every room's tickTimer and leaseRefreshTimer without the
   *  owner-changed side effects `evictRoom` performs (no point notifying
   *  clients or releasing the lease mid-process-shutdown — the lease's own
   *  TTL expiry already covers that). Call this on process shutdown
   *  (SIGINT/SIGTERM — see server.ts) and in test teardown: leaving these
   *  intervals running keeps the event loop alive for no reason after the
   *  RoomManager itself is no longer reachable.
   *
   *  Async since Phase 7: flushes every room's pending object writes before
   *  clearing state, so a debounce window in progress at the moment of
   *  shutdown doesn't silently lose edits. */
  async disposeAll(): Promise<void> {
    for (const room of this.rooms.values()) {
      clearInterval(room.tickTimer);
      clearInterval(room.leaseRefreshTimer);
    }
    await this.objectPersistence.flushAllAndDispose();
    this.rooms.clear();
    this.lastEmittedPositions.clear();
  }
}
