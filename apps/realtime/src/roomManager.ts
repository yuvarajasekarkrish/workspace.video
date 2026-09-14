import type { Server as SocketIOServer } from "socket.io";
import type { Point } from "@cosmos/shared";
import { ServerEvents, DEFAULT_MOVEMENT_CONFIG, DEFAULT_PROXIMITY_CONFIG } from "@cosmos/shared";
import type { RoomLease } from "@cosmos/realtime-core";
import {
  validateMove,
  tickProximity,
  pairKey,
  type ProximityState,
} from "@cosmos/proximity";

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
      tickTimer: NodeJS.Timeout;
      leaseRefreshTimer: NodeJS.Timeout;
    }
  >();

  constructor(
    private readonly broadcaster: RoomBroadcaster,
    private readonly lease: RoomLease,
    private readonly instanceId: string,
    private readonly leaseRefreshIntervalMs = 10_000,
  ) {}

  /** Called once this instance has confirmed (via the lease) that it owns
   *  `roomId`. Idempotent — safe to call on every join. */
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
        this.evictRoom(roomId, { notifyOwnerChanged: true });
      }
    }, this.leaseRefreshIntervalMs);

    this.rooms.set(roomId, {
      peers: new Map(),
      proximityStates: new Map(),
      tickTimer,
      leaseRefreshTimer,
    });
  }

  addPeer(roomId: string, peer: Omit<PeerState, "acceptedAtMs">): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.peers.set(peer.userId, { ...peer, acceptedAtMs: Date.now() });
  }

  removePeer(roomId: string, userId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.peers.delete(userId);
    this.broadcaster.to(roomId).emit(ServerEvents.PeersDelta, { roomId, updates: [], left: [userId] });

    if (room.peers.size === 0) {
      this.evictRoom(roomId, { notifyOwnerChanged: false });
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

  private evictRoom(roomId: string, opts: { notifyOwnerChanged: boolean }): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    clearInterval(room.tickTimer);
    clearInterval(room.leaseRefreshTimer);
    this.lastEmittedPositions.delete(roomId);

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
   *  RoomManager itself is no longer reachable. */
  disposeAll(): void {
    for (const room of this.rooms.values()) {
      clearInterval(room.tickTimer);
      clearInterval(room.leaseRefreshTimer);
    }
    this.rooms.clear();
    this.lastEmittedPositions.clear();
  }
}
