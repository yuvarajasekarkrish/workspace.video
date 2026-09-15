import type { Server as SocketIOServer } from "socket.io";
import type {
  Point,
  ObjectState,
  ActiveParticipantCounter,
  AdmitParticipantResult,
  MovementConfig,
  RoomLayout,
} from "@cosmos/shared";
import {
  ServerEvents,
  DEFAULT_MOVEMENT_CONFIG,
  DEFAULT_PROXIMITY_CONFIG,
  admitParticipant,
  resolveLayout,
  DEFAULT_LAYOUT_ID,
  seatById,
  zoneAt,
  zoneById,
} from "@cosmos/shared";
import type { RoomLease } from "@cosmos/realtime-core";
import {
  validateMove,
  tickProximity,
  pairKey,
  statesEqual,
  resolveObjectWrite,
  resolveObjectDelete,
  resolveSeatClaim,
  effectiveAudio,
  type ProximityState,
  type ProposedObjectWrite,
  type ObjectWriteResult,
  type ObjectDeleteOutcome,
  type SeatClaimResult,
  type ZoneRef,
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
 *
 * Implements ActiveParticipantCounter (keyed by workspaceId, not roomId) so
 * that "how many people may be in this workspace at once" (a
 * ParticipantLimitProvider, resolved in server.ts from Workspace.plan) and
 * "who is here right now" stay decoupled: Phase 8's product constraint is one
 * office room per workspace, but activeUserIds() already unions peers across
 * every room this instance owns for a workspace, so a future multi-room
 * workspace needs no change here — only a cross-instance (Redis-backed)
 * implementation of this same interface if rooms end up owned by different
 * instances.
 */
export class RoomManager implements ActiveParticipantCounter {
  private rooms = new Map<
    string,
    {
      workspaceId: string;
      /** This room's floor bounds, resolved once at ensureRoom() from its
       *  layout (see @cosmos/shared's movementConfigForLayout) — applyMove
       *  validates against THIS, never the global DEFAULT_MOVEMENT_CONFIG,
       *  so a room's floor size is what actually bounds where a peer can
       *  walk. */
      movementConfig: MovementConfig;
      /** Resolved once at ensureRoom() — the source of seat geometry for
       *  claimSeat's existence/proximity checks. Never re-resolved mid-room
       *  lifetime (a layout doesn't change under a live room). */
      layout: RoomLayout;
      peers: Map<string, PeerState>; // keyed by userId
      /** Hot-desk occupancy: seatId -> the userId sitting there. Never
       *  persisted — lost on eviction/failover by design (see the plan's
       *  R3/occupancy-lifecycle notes); reconstructed from nothing because
       *  a seat is a session-scoped claim, not durable room content. */
      seats: Map<string, string>;
      /** Reverse index of `seats`, so releaseSeat/removePeer/a move from a
       *  seated peer can find "which seat is THIS user in" in O(1) instead
       *  of scanning `seats`. Kept in lockstep with it everywhere it's
       *  written. */
      seatOf: Map<string, string>;
      /** Raw, UN-overridden tickProximity output — deliberately never
       *  written with a zone-overridden value (that would corrupt
       *  hysteresis, since computeProximityState reads this as its
       *  "wasAudio"/"wasVideo" baseline; see tick()'s docs). */
      proximityStates: Map<string, ProximityState>; // keyed by pairKey(a,b)
      /** Each peer's current zone id (or null), diffed every tick against
       *  the previous tick's value — this is what lets a zone crossing
       *  between two STATIONARY people still trigger an audio update, since
       *  tickProximity alone only reports pairs whose DISTANCE changed. */
      zoneOf: Map<string, string | null>;
      /** The last EFFECTIVE (post zone-override) audio state actually sent
       *  to each directed listener<-speaker pair, keyed by
       *  "${listenerUserId}->${speakerUserId}" — separate from
       *  proximityStates because the two must never be conflated (see
       *  tick()'s docs on the trap that would create). */
      lastEmittedAudio: Map<string, ProximityState>;
      objects: Map<string, ObjectState>; // keyed by objectId
      /** Last participant limit passed to admitAndAddPeer for this room —
       *  cached so removePeer (which has no limit of its own to work with)
       *  can still broadcast an accurate occupancy:update. Always set before
       *  removePeer matters, since a peer can only be present to remove
       *  after at least one successful admitAndAddPeer call. */
      participantLimit: number;
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
   *  persisted objects is a separate async step — see hydrateObjects().
   *  `workspaceId` is recorded so activeUserIds() can be computed per
   *  workspace rather than per room. `movementConfig`/`layout` default to
   *  the global bounds and the default office layout so every existing
   *  call site (tests included) that never passed either is unaffected. */
  ensureRoom(
    roomId: string,
    workspaceId: string,
    movementConfig: MovementConfig = DEFAULT_MOVEMENT_CONFIG,
    layout: RoomLayout = resolveLayout(DEFAULT_LAYOUT_ID)!,
  ): void {
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
      workspaceId,
      movementConfig,
      layout,
      peers: new Map(),
      seats: new Map(),
      seatOf: new Map(),
      proximityStates: new Map(),
      zoneOf: new Map(),
      lastEmittedAudio: new Map(),
      objects: new Map(),
      participantLimit: 0,
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

  /** Every distinct user currently present across every room this instance
   *  owns for the given workspace — the ActiveParticipantCounter contract.
   *  Today that's at most one room (Phase 8's one-office-room-per-workspace
   *  product constraint), but this method doesn't assume that: it unions
   *  peers across all matching rooms, so a future multi-room workspace is
   *  transparent to callers of admitParticipant. */
  activeUserIds(workspaceId: string): ReadonlySet<string> {
    const ids = new Set<string>();
    for (const room of this.rooms.values()) {
      if (room.workspaceId !== workspaceId) continue;
      for (const userId of room.peers.keys()) ids.add(userId);
    }
    return ids;
  }

  /** Current occupancy for display (HUD, capacity screens) — active count is
   *  workspace-wide via activeUserIds(); limit is this room's most recently
   *  seen participant limit. Returns zeros for an unknown room rather than
   *  throwing, since this is read for UI display, not an authorization
   *  decision (admitAndAddPeer is the actual gate). */
  occupancy(roomId: string): { active: number; limit: number } {
    const room = this.rooms.get(roomId);
    if (!room) return { active: 0, limit: 0 };
    return { active: this.activeUserIds(room.workspaceId).size, limit: room.participantLimit };
  }

  /** Checks the workspace's participant limit and, if there is room, adds
   *  the peer — in the same synchronous call, so two sockets racing for the
   *  last slot cannot both be admitted (Node serializes synchronous code on
   *  the instance that owns this room's lease). `limit` is resolved by the
   *  caller (server.ts, via a ParticipantLimitProvider) rather than fetched
   *  here, keeping RoomManager itself free of I/O — the same separation
   *  Phase 7 established between RoomManager and its injected
   *  ObjectRepository.
   *
   *  On admission, broadcasts occupancy:update so everyone already in the
   *  room sees the new count immediately (the joining client instead learns
   *  it from peers:snapshot, sent right after this call in server.ts). */
  admitAndAddPeer(
    roomId: string,
    peer: Omit<PeerState, "acceptedAtMs">,
    limit: number,
  ): AdmitParticipantResult {
    const room = this.rooms.get(roomId);
    if (!room) {
      return { admitted: false, reason: "workspace_full", limit, active: 0 };
    }

    room.participantLimit = limit;
    const result = admitParticipant(this.activeUserIds(room.workspaceId), peer.userId, limit);
    if (!result.admitted) return result;

    room.peers.set(peer.userId, { ...peer, acceptedAtMs: Date.now() });
    const occ = this.occupancy(roomId);
    this.broadcaster.to(roomId).emit(ServerEvents.OccupancyUpdate, { roomId, ...occ });
    return result;
  }

  /** Returns a Promise (rather than being fire-and-forget) so callers that
   *  care about eviction actually completing — including a pending object
   *  flush — can await it; server.ts's disconnect handler does not need to
   *  and does not. */
  async removePeer(roomId: string, userId: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // Unconditional, regardless of how many peers remain — evictRoom only
    // fires once the room is EMPTY, which a busy room may never reach, so
    // this is the only reliable place a leaked seat gets freed.
    this.releaseSeat(roomId, userId);

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

    // Same leak/stale-cache class of bug as proximityStates above, for the
    // two zone-audio-specific maps: an untended zoneOf entry is a memory
    // leak, and a stale lastEmittedAudio entry for a departed user could
    // suppress a genuinely new emit to/from a same-named future connection.
    room.zoneOf.delete(userId);
    for (const key of room.lastEmittedAudio.keys()) {
      if (key.startsWith(`${userId}->`) || key.endsWith(`->${userId}`)) {
        room.lastEmittedAudio.delete(key);
      }
    }

    this.broadcaster.to(roomId).emit(ServerEvents.PeersDelta, { roomId, updates: [], left: [userId] });

    // Leaving is the one occupancy-changing path peers:snapshot doesn't
    // cover (that's only re-sent on a join) — without this, everyone still
    // in the room would see a stale "active" count until someone else joins.
    const occ = this.occupancy(roomId);
    this.broadcaster.to(roomId).emit(ServerEvents.OccupancyUpdate, { roomId, ...occ });

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

    // A move from a seated peer is treated as an implicit stand-up — the
    // client stands up optimistically (see the approved plan) and may send
    // its next move before the corresponding seat:release arrives; release
    // is idempotent, so whichever order they arrive in is safe.
    this.releaseSeat(roomId, userId);

    const result = validateMove(
      proposed,
      { position: peer.position, acceptedAtMs: peer.acceptedAtMs },
      Date.now(),
      room.movementConfig,
    );

    if (result.accepted) {
      peer.position = result.position;
      peer.acceptedAtMs = Date.now();
    }

    return result;
  }

  /** Current seat occupancy, sent to a joining client as seats:snapshot —
   *  never broadcast to the whole room on a join, for the identical reason
   *  objects:snapshot isn't either (see that method's docs). */
  seatsSnapshot(roomId: string): { seatId: string; userId: string }[] {
    const room = this.rooms.get(roomId);
    if (!room) return [];
    return Array.from(room.seats.entries()).map(([seatId, userId]) => ({ seatId, userId }));
  }

  /** Claims a hot-desk seat for `userId`. The proximity check uses the
   *  peer's own last-accepted SERVER position, never a client-supplied
   *  point (see seatOccupancy.ts's docs on why). On acceptance, teleports
   *  the peer directly to the seat's anchor — this is the separate,
   *  speed-check-bypassing action validateMove's own docstring requires for
   *  teleport-style repositioning; `acceptedAtMs` is updated in the SAME
   *  assignment as `position` so a stale queued `move` can't be validated
   *  against a fresh elapsed-time window and silently pull the peer back
   *  out of the chair (see the plan's explicit test for this). Any
   *  previously-held seat is released as part of the same accepted claim. */
  claimSeat(roomId: string, userId: string, seatId: string): SeatClaimResult | undefined {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(userId);
    if (!room || !peer) return undefined;

    const seat = seatById(room.layout, seatId);
    const result = resolveSeatClaim(
      seat,
      peer.position,
      room.seats.get(seatId),
      userId,
      room.seatOf.get(userId) ?? null,
    );

    if (result.accepted) {
      if (result.previousSeatId) {
        room.seats.delete(result.previousSeatId);
        this.broadcaster.to(roomId).emit(ServerEvents.SeatUpdate, { seatId: result.previousSeatId, userId: null });
      }
      room.seats.set(seatId, userId);
      room.seatOf.set(userId, seatId);
      peer.position = seat!.anchor;
      peer.acceptedAtMs = Date.now();
      this.broadcaster.to(roomId).emit(ServerEvents.SeatUpdate, { seatId, userId });
    }

    return result;
  }

  /** Frees whichever seat `userId` currently holds. Idempotent — a no-op
   *  when the user holds no seat, which is what makes the optimistic
   *  stand-up / implicit-release-on-move race (see applyMove) safe: however
   *  many release paths fire for the same stand-up, only the first does
   *  anything. */
  releaseSeat(roomId: string, userId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;

    const seatId = room.seatOf.get(userId);
    if (!seatId) return;

    room.seatOf.delete(userId);
    room.seats.delete(seatId);
    this.broadcaster.to(roomId).emit(ServerEvents.SeatUpdate, { seatId, userId: null });
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

  /** Test-only peek at the RAW (never zone-overridden) cached proximity
   *  state for a pair — lets tests assert directly that proximityStates was
   *  never corrupted by a zone audio override, the same spirit as
   *  runTickForTest above. Production code never calls this. */
  proximityStateForTest(roomId: string, a: string, b: string): ProximityState | undefined {
    return this.rooms.get(roomId)?.proximityStates.get(pairKey(a, b));
  }

  /** Rolling per-tick duration samples across every room this instance owns
   *  — an instance-wide health signal, not per-room, since what the load
   *  harness (see the plan's final step) cares about is how the ONE process
   *  handling N concurrent connections is doing overall. Exposed via
   *  getTickStats() -> server.ts's /internal/metrics. */
  private readonly tickDurationsMs: number[] = [];
  private static readonly MAX_TICK_SAMPLES = 200;

  /** Rolling tick-duration stats for /internal/metrics. Empty stats (all
   *  zero) before the first tick has run. */
  getTickStats(): { sampleCount: number; avgMs: number; maxMs: number } {
    const samples = this.tickDurationsMs;
    if (samples.length === 0) return { sampleCount: 0, avgMs: 0, maxMs: 0 };
    const sum = samples.reduce((a, b) => a + b, 0);
    return { sampleCount: samples.length, avgMs: sum / samples.length, maxMs: Math.max(...samples) };
  }

  private tick(roomId: string): void {
    const start = performance.now();
    this.tickBody(roomId);
    this.tickDurationsMs.push(performance.now() - start);
    if (this.tickDurationsMs.length > RoomManager.MAX_TICK_SAMPLES) this.tickDurationsMs.shift();
  }

  private tickBody(roomId: string): void {
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
    // pair states. `room.proximityStates` stores exactly this RAW output,
    // forever — never a zone-overridden value. Writing an override back in
    // here would corrupt computeProximityState's hysteresis, since it reads
    // this cache as its own "wasAudio"/"wasVideo" baseline next tick (see
    // packages/proximity/src/proximity.ts) — a zone-forced full-gain pair
    // would then get an undeserved +hysteresisPx grace band the moment
    // distance alone is checked again, e.g. right after leaving the zone.
    const changes = tickProximity(currentPositions, room.proximityStates, DEFAULT_PROXIMITY_CONFIG);
    for (const change of changes) {
      room.proximityStates.set(pairKey(change.a, change.b), change.state);
    }

    // Zone membership: diffed independently every tick, because
    // tickProximity above only reports pairs whose DISTANCE changed — two
    // people already standing still together when one crosses into a
    // meeting room produces zero distance change and would otherwise emit
    // nothing, even though what they can hear just changed completely.
    const zoneChangedUsers: string[] = [];
    for (const peer of room.peers.values()) {
      const zone = zoneAt(room.layout, peer.position);
      const zoneId = zone?.id ?? null;
      const previousZoneId = room.zoneOf.get(peer.userId) ?? null;
      if (zoneId !== previousZoneId) {
        room.zoneOf.set(peer.userId, zoneId);
        zoneChangedUsers.push(peer.userId);
        this.broadcaster.to(peer.socketId).emit(ServerEvents.ZoneChanged, {
          zone: zone ? { id: zone.id, label: zone.label, kind: zone.kind } : null,
        });
      }
    }

    // Candidate pairs for a directed audio re-check: every pair whose raw
    // distance-state changed, UNION every pair involving a user whose zone
    // just changed (that user crossing a boundary can change what THEY
    // hear from, and are heard by, everyone else — not just the nearest
    // peer, which is why this fans out to all current peers, not just
    // `changes`'s pairs).
    const candidatePairs = new Set<string>();
    for (const change of changes) candidatePairs.add(pairKey(change.a, change.b));
    if (zoneChangedUsers.length > 0) {
      const allUserIds = Array.from(room.peers.keys());
      for (const changedUserId of zoneChangedUsers) {
        for (const otherUserId of allUserIds) {
          if (otherUserId !== changedUserId) candidatePairs.add(pairKey(changedUserId, otherUserId));
        }
      }
    }

    const zoneRefFor = (userId: string): ZoneRef | null => {
      const zoneId = room.zoneOf.get(userId);
      if (!zoneId) return null;
      const zone = zoneById(room.layout, zoneId);
      return zone ? { id: zone.id, kind: zone.kind, stageId: zone.stageId } : null;
    };

    for (const key of candidatePairs) {
      const [a, b] = key.split(":") as [string, string];
      const raw = room.proximityStates.get(key);
      if (!raw) continue; // one side already left this tick

      const zoneA = zoneRefFor(a);
      const zoneB = zoneRefFor(b);

      this.maybeEmitDirectedAudio(room, roomId, a, b, effectiveAudio(raw, zoneA, zoneB));
      this.maybeEmitDirectedAudio(room, roomId, b, a, effectiveAudio(raw, zoneB, zoneA));
    }
  }

  /** Emits proximity:update to `listenerUserId` about `speakerUserId` only
   *  if the EFFECTIVE (post zone-override) state actually differs from what
   *  was last sent for this exact direction — dedup lives here, keyed
   *  separately per direction, since a stage/audience pair (or any private
   *  zone pairing) is asymmetric by design. */
  private maybeEmitDirectedAudio(
    room: NonNullable<ReturnType<RoomManager["rooms"]["get"]>>,
    roomId: string,
    listenerUserId: string,
    speakerUserId: string,
    state: ProximityState,
  ): void {
    const key = `${listenerUserId}->${speakerUserId}`;
    const previous = room.lastEmittedAudio.get(key);
    if (previous && statesEqual(previous, state)) return;

    room.lastEmittedAudio.set(key, state);
    const listenerSocketId = room.peers.get(listenerUserId)?.socketId;
    if (listenerSocketId) {
      this.broadcaster.to(listenerSocketId).emit(ServerEvents.ProximityUpdate, { peerId: speakerUserId, ...state });
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
