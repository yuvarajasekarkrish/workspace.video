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
  pairKey,
  resolveObjectWrite,
  resolveObjectDelete,
  resolveSeatClaim,
  effectiveAudio,
  SparseProximityTracker,
  UniformGridIndex,
  NOT_NEARBY,
  type ProximityState,
  type ProposedObjectWrite,
  type ObjectWriteResult,
  type ObjectDeleteOutcome,
  type SeatClaimResult,
  type ZoneRef,
} from "@cosmos/proximity";

/** Reused for every "no counterpart members" return in zoneRecheckCounterparts
 *  so that path doesn't allocate a fresh empty Set every call. Never mutated. */
const EMPTY_USER_SET: ReadonlySet<string> = new Set();

/** Below this absolute gain delta, a pure gain wobble (no subscribe/
 *  unsubscribe edge, no hitting exactly 0 or 1) is not worth an emit — see
 *  maybeEmitDirectedAudio's docs. The client already smooths gain locally,
 *  so a step this small is inaudible. */
const GAIN_EMIT_THRESHOLD = 0.02;

/** Whether an effective-audio transition from `previous` to `next` is worth
 *  sending to the listener. Subscribe/unsubscribe or video-subscribe edges
 *  always matter; gain reaching exactly its 0/1 endpoints always matters
 *  (those are perceptually meaningful "fully off"/"fully on" states); a
 *  pure in-between gain wobble only matters past GAIN_EMIT_THRESHOLD. */
function shouldEmitAudioChange(previous: ProximityState, next: ProximityState): boolean {
  if (previous.audioSubscribed !== next.audioSubscribed) return true;
  if (previous.videoSubscribed !== next.videoSubscribed) return true;
  if (next.audioGain === 0 || next.audioGain === 1) return previous.audioGain !== next.audioGain;
  return Math.abs(previous.audioGain - next.audioGain) >= GAIN_EMIT_THRESHOLD;
}
import { ObjectPersistence, noopObjectRepository, type ObjectRepository } from "./objectPersistence";

/** Hard cap on objects per room, checked before accepting a create — bounds
 *  the worst case for both realtime-process memory and the objects table. */
const MAX_OBJECTS_PER_ROOM = 2000;

export type ObjectUpsertOutcome = ObjectWriteResult | { accepted: false; reason: "room_full"; authoritative: null };

/** Per-tick phase timing breakdown, in ms — see tickBody's phase marks.
 *  Exists so Phase 10 can prove or disprove "emission dominates the tick"
 *  instead of only ever seeing one combined number. */
export interface TickPhaseTimings {
  /** Building the batched position delta + the peers:delta emit. */
  positionsMs: number;
  /** room.proximity.tick — the spatial-index-driven proximity recompute. */
  proximityMs: number;
  /** Zone-membership diff, zone:changed emits, and building the directed-
   *  audio candidate-pair set (everything before the final emit loop). */
  zoneMs: number;
  /** The directed-audio loop itself, including every proximity:update emit
   *  it sends — this is where Socket.IO/Redis-adapter emit cost lands. */
  audioEmitMs: number;
}

/** One sampled `move` validation, for diagnosing the correction rate — see
 *  RoomManager.applyMove. Every field describes the SAME move. */
type EventLoopUtilization = ReturnType<typeof performance.eventLoopUtilization>;

/** Diagnostics only: process-wide load over one tick window, next to the
 *  largest number of different users whose moves were rejected within the
 *  same 10ms server instant in that window. */
export interface TickWindowSample {
  /** performance.now() at the END of the window — the shared clock that tail
   *  emits and GC pauses are stamped with, so they can be lined up. */
  atMs: number;
  windowMs: number;
  elu: number;
  cpuWallRatio: number;
  tickMs: number;
  maxClusterUsers: number;
  /** Emit calls made inside this window's tick, and the time spent in them. */
  emitCount: number;
  emitMs: number;
  /** How long after this window's tick ended the loop reached its check phase
   *  (a setImmediate scheduled at the end of the tick). The poll phase, where
   *  inbound frames and write completions are processed, runs in between, so
   *  this is the size of the burst of work that follows the tick. null until
   *  that immediate has run, and always null with diagnostics off. */
  postTickMs: number | null;
}

/** Diagnostics hooks the tick calls; supplied by server.ts, absent in tests
 *  that do not care. Read-only: none of them may change what the tick does. */
export interface TickDiagnostics {
  beginTick(): void;
  endTick(): { emitCount: number; emitMs: number };
}

export interface MoveValidationSample {
  /** Since this user's last ACCEPTED move — the exact basis validateMove
   *  divides by, so this is what determines the speed budget. */
  elapsedMs: number;
  distancePx: number;
  impliedSpeedPxPerSec: number;
  /** Server-side gap since this user's previous move ARRIVED (accepted or
   *  not); null for a user's first move. */
  serverGapMs: number | null;
  /** The same gap as the client's own clientTs values report it; null when
   *  unavailable. Compared with serverGapMs: a client gap near the move
   *  interval against a server gap near 0 means the moves were emitted
   *  apart but arrived together, i.e. compression happened after the emit.
   *  A client gap near 0 would mean the sender itself emitted them
   *  together. Gaps are differences of two client timestamps, so they are
   *  independent of any clock offset between client and server. */
  clientGapMs: number | null;
  /** Server receipt time (ms epoch) and the user, so a later analysis can
   *  test whether rejections from DIFFERENT users cluster at the same
   *  instant (a server-wide event) or not (a per-connection effect). */
  atMs: number;
  userId: string;
}

/** Minimal emitter surface RoomManager needs from Socket.IO — narrowed so
 *  unit tests can pass a lightweight fake instead of a real server. */
export interface RoomBroadcaster {
  to(room: string): { emit(event: string, payload: unknown): void };
  disconnectSocketsInRoom(roomId: string): void;
}

/** Phase 10 fix (see the plan's L1 lead): every tick-path emit
 *  (`peers:delta`, `proximity:update`, `zone:changed`) previously went
 *  through `io.to(...)`, which the `@socket.io/redis-adapter` fans out with
 *  a Redis PUBLISH on top of local delivery — measured at ~1000
 *  publishes/sec at 200 users, and the dominant cost in the tick (the
 *  audioEmit phase alone averaged 90%+ of total tick time). Those
 *  publishes are pure waste: `join_room` (server.ts) refuses to admit a
 *  socket into a room this instance doesn't hold the lease for, so every
 *  peer RoomManager ever emits to is ALREADY local to this process — no
 *  other instance is listening for these events on this room. Using
 *  `io.local.to(...)` for exactly these three event names skips the
 *  adapter's cross-instance fan-out for the hot per-tick path while
 *  leaving every other emit (object sync, seats, occupancy, owner:changed
 *  — none of them on the 100ms tick loop) going through the normal
 *  cross-instance-capable path, unchanged. */
const TICK_PATH_LOCAL_ONLY_EVENTS: ReadonlySet<string> = new Set([
  ServerEvents.PeersDelta,
  ServerEvents.ProximityUpdate,
  ServerEvents.ZoneChanged,
]);

export function broadcasterFromSocketServer(io: SocketIOServer): RoomBroadcaster {
  return {
    to: (room) => ({
      emit: (event: string, payload: unknown) => {
        const target = TICK_PATH_LOCAL_ONLY_EVENTS.has(event) ? io.local.to(room) : io.to(room);
        target.emit(event, payload);
      },
    }),
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
  /** Unspent movement allowance carried from the last accepted move (ms of
   *  full-speed travel, capped by MovementConfig.maxBurstMs) — see
   *  validateMove. Absent means 0. */
  moveCreditMs?: number;
  /** Phase 15 Part B diagnostics ONLY — never read by validateMove. Server
   *  receipt time and the client's own clientTs of this peer's previous
   *  `move`, accepted or not (acceptedAtMs above only advances on ACCEPTED
   *  moves, so it can't give the gap between consecutive arrivals). The
   *  clientTs stays untrusted: it is stored as a number for comparison in
   *  diagnostic samples and is deliberately never used to decide anything. */
  lastMoveReceivedAtMs?: number;
  lastMoveClientTs?: number;
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
      /** Raw, UN-overridden proximity output — deliberately never written
       *  with a zone-overridden value (that would corrupt hysteresis, since
       *  computeProximityState reads this as its "wasAudio"/"wasVideo"
       *  baseline; see tick()'s docs). Phase 9: an O(candidate-pairs) sparse
       *  tracker (only non-NOT_NEARBY pairs are stored) replaces the Phase
       *  8 full-pair Map, paired 1:1 with `index` below — see
       *  docs/architecture/realtime-spatial-partitioning.md. */
      proximity: SparseProximityTracker;
      /** Spatial hash of every peer's current position, kept in lockstep
       *  with `peers` at every write (admit, move, seat teleport, remove).
       *  Cell size is audioRadiusPx + hysteresisPx, so any pair that could
       *  possibly be non-NOT_NEARBY is guaranteed to be a candidate pair —
       *  see UniformGridIndex's doc comment for the proof. */
      index: UniformGridIndex;
      /** Each peer's current zone id (or null), diffed every tick against
       *  the previous tick's value — this is what lets a zone crossing
       *  between two STATIONARY people still trigger an audio update, since
       *  the proximity tracker alone only reports pairs whose DISTANCE
       *  changed. */
      zoneOf: Map<string, string | null>;
      /** Reverse index of `zoneOf`: zoneId -> the userIds currently in it.
       *  Needed because a zone rule can grant full-gain audio between people
       *  who are physically far apart (a stage's audience, everyone in one
       *  meeting room) — those pairs would never appear in `index`'s grid
       *  neighbourhood, so the zone-change candidate set must also include
       *  "everyone else in this zone / the linked stage-audience zone"
       *  rather than only grid neighbours. Kept in lockstep with `zoneOf`
       *  everywhere it's written. */
      usersByZone: Map<string, Set<string>>;
      /** The last EFFECTIVE (post zone-override) audio state actually sent
       *  to each directed listener<-speaker pair, nested
       *  listenerUserId -> speakerUserId -> state — separate from
       *  `proximity` because the two must never be conflated (see tick()'s
       *  docs on the trap that would create). An entry is deleted once the
       *  effective state returns to NOT_NEARBY, so memory stays proportional
       *  to peers a user can actually hear, not every peer who ever passed
       *  through the room. */
      lastEmittedAudio: Map<string, Map<string, ProximityState>>;
      /** Reverse index of `lastEmittedAudio`: speakerUserId -> the set of
       *  listeners who currently have an entry for them. Exists solely so
       *  `removePeer` can prune "this departing user as someone else's
       *  speaker" in O(degree) instead of scanning every listener's map. */
      audienceOf: Map<string, Set<string>>;
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
      /** True while a refresh() call for this room is awaiting Redis. Guards
       *  against a slow eval causing two overlapping refreshes to race each
       *  other — see ensureRoom's leaseRefreshTimer callback. */
      leaseRefreshInFlight: boolean;
    }
  >();

  /** Counts of every refresh() outcome across all rooms, surfaced via
   *  getLeaseStats() -> server.ts's /internal/metrics (Phase 11 Part C).
   *  "reclaimed" and "errors" matter most: either one means a room's lease
   *  briefly lapsed without another instance actually taking over, which
   *  used to evict 100% of that room's sockets — see the leaseRefreshTimer
   *  callback below for why that no longer happens. */
  private leaseOutcomeCounts = { renewed: 0, reclaimed: 0, lost: 0, errors: 0 };

  /** Disconnects ignored because they came from a socket the peer had
   *  already replaced by re-joining — see removePeer. Non-zero means the
   *  reconnect race actually happened and the guard actually fired. */
  private staleDisconnectsIgnored = 0;
  getStaleDisconnectsIgnored(): number {
    return this.staleDisconnectsIgnored;
  }

  getLeaseStats(): { renewed: number; reclaimed: number; lost: number; errors: number } {
    return { ...this.leaseOutcomeCounts };
  }

  /** Phase 15 Part B: raw samples of elapsed-since-last-accepted-move for
   *  BOTH accepted and rejected moves, sampled 1-in-20 (same convention as
   *  CountingBroadcaster's payload-byte sampling) — see applyMove below.
   *  This exists to test, not assume, the "double-drain" hypothesis for the
   *  correction rate: if a server event-loop stall lets two moves from the
   *  same user land in one drain, the second is validated against an
   *  acceptedAtMs just set microseconds earlier, so its elapsed collapses
   *  toward 0 while its real (legitimate) distance does not — producing an
   *  enormous implied speed and a rejection, even though the user did
   *  nothing wrong. Comparing the accepted-move distribution (expected to
   *  cluster near the client's real move interval) against the rejected one
   *  is what would show that collapse directly, rather than inferring it
   *  from an unrelated aggregate like tick or event-loop timing — see the
   *  Phase 15 plan's explicit guard against that inference. */
  private static readonly MAX_ACCEPTED_MOVE_SAMPLES = 200;
  private static readonly MAX_REJECTED_MOVE_SAMPLES = 300;
  private readonly acceptedMoveSamples: MoveValidationSample[] = [];
  private readonly rejectedMoveSamples: MoveValidationSample[] = [];
  private moveSampleCounter = 0;

  getMoveValidationStats(): {
    accepted: MoveValidationSample[];
    rejected: MoveValidationSample[];
    windows: TickWindowSample[];
  } {
    return {
      accepted: [...this.acceptedMoveSamples],
      rejected: [...this.rejectedMoveSamples],
      windows: this.tickWindowsOldestFirst(),
    };
  }

  /** Once the ring is full, the next write position is also where the oldest
   *  window lives, so a plain copy would hand back a rotated array. */
  private tickWindowsOldestFirst(): TickWindowSample[] {
    if (this.tickWindows.length < RoomManager.MAX_TICK_WINDOWS) return [...this.tickWindows];
    const oldest = this.tickWindowWriteIndex % RoomManager.MAX_TICK_WINDOWS;
    return [...this.tickWindows.slice(oldest), ...this.tickWindows.slice(0, oldest)];
  }

  /** Diagnostics only. One sample per tick window (the span since the previous
   *  tick finished), piggybacking on the existing tick — no extra timer. The
   *  window is instance-wide, not per-room, matching the tick samples above.
   *  Fixed-size ring, 400 windows ≈ 40s at the 100ms tick. */
  private static readonly MAX_TICK_WINDOWS = 400;
  private readonly tickWindows: TickWindowSample[] = [];
  private tickWindowWriteIndex = 0;
  private windowBaseline: { wallMs: number; cpuUsage: NodeJS.CpuUsage; elu: EventLoopUtilization } | null = null;
  private windowRejectBuckets = new Map<number, Set<string>>();

  private readonly objectPersistence: ObjectPersistence;

  constructor(
    private readonly broadcaster: RoomBroadcaster,
    private readonly lease: RoomLease,
    private readonly instanceId: string,
    private readonly leaseRefreshIntervalMs = 10_000,
    objectRepository: ObjectRepository = noopObjectRepository,
    private readonly diagnostics?: TickDiagnostics,
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
    // Phase 15 Part A: passed in, not defaulted to 0 and set later by
    // admitAndAddPeer. getRoomInfo(roomId) returning a record is meant to
    // mean that record is FULLY initialised — server.ts's join fast path
    // trusts participantLimit without re-deriving it. A room that started
    // at 0 and was only corrected after the slow path's DB round trips left
    // a real window where a concurrent joiner's fast path read limit 0 and
    // was wrongly refused workspace_full. Callers that don't have a limit
    // yet (existing tests) get 0, matching the old default and its
    // fail-closed behavior — this only removes the LATER, silent overwrite.
    participantLimit = 0,
  ): void {
    if (this.rooms.has(roomId)) return;

    const tickTimer = setInterval(
      () => this.tick(roomId),
      DEFAULT_PROXIMITY_CONFIG.tickIntervalMs,
    );

    // Refresh the lease well inside its TTL. Only a "lost" outcome — another
    // instance now genuinely holds the key — means this instance is no
    // longer authoritative; evict local state and boot connected clients
    // back to endpoint resolution rather than keep serving stale state. A
    // "reclaimed" outcome (the key merely expired, e.g. a transient Redis
    // TTL/timing hiccup, and nothing else raced to claim it) self-heals in
    // place: we still hold every peer/socket/tick for this room, so there is
    // nothing to evict. A thrown error (Redis unreachable for this call) is
    // caught and skipped rather than evicting on a guess — if the room truly
    // failed over, the NEXT successful refresh will correctly observe "lost".
    const leaseRefreshTimer = setInterval(async () => {
      const room = this.rooms.get(roomId);
      if (!room || room.leaseRefreshInFlight) return; // guards against overlap on a slow eval
      room.leaseRefreshInFlight = true;
      try {
        const outcome = await this.lease.refresh(this.instanceId, roomId);
        this.leaseOutcomeCounts[outcome]++;
        if (outcome === "reclaimed") {
          console.warn(
            `[roomLease] reclaimed an expired lease for room ${roomId} (instance ${this.instanceId}, ${room.peers.size} peer(s)) — no other instance had claimed it; continuing without eviction.`,
          );
        } else if (outcome === "lost") {
          await this.evictRoom(roomId, { notifyOwnerChanged: true });
        }
      } catch (err) {
        this.leaseOutcomeCounts.errors++;
        console.error(`[roomLease] refresh failed for room ${roomId} (instance ${this.instanceId}):`, err);
      } finally {
        // The room may have just been evicted (and thus deleted from
        // this.rooms) by the "lost" branch above — guard the flag write.
        const stillTracked = this.rooms.get(roomId);
        if (stillTracked) stillTracked.leaseRefreshInFlight = false;
      }
    }, this.leaseRefreshIntervalMs);

    // Cell size = the largest distance at which two peers can be anything
    // other than NOT_NEARBY (see UniformGridIndex's doc comment). The grid's
    // own world bounds match this room's floor, not the movement config's
    // (they're the same values via movementConfigForLayout, but the grid
    // only cares about the floor's physical extent).
    const cellSize = DEFAULT_PROXIMITY_CONFIG.audioRadiusPx + DEFAULT_PROXIMITY_CONFIG.hysteresisPx;

    this.rooms.set(roomId, {
      workspaceId,
      movementConfig,
      layout,
      peers: new Map(),
      seats: new Map(),
      seatOf: new Map(),
      proximity: new SparseProximityTracker(),
      index: new UniformGridIndex(movementConfig.roomWidthPx, movementConfig.roomHeightPx, cellSize),
      zoneOf: new Map(),
      usersByZone: new Map(),
      lastEmittedAudio: new Map(),
      audienceOf: new Map(),
      objects: new Map(),
      participantLimit,
      objectsHydration: null,
      tickTimer,
      leaseRefreshTimer,
      leaseRefreshInFlight: false,
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
    // Keep the spatial index in lockstep with `peers` at every position
    // write — `insert` itself handles the "already indexed" (reconnect)
    // case by moving instead, so this is safe to call unconditionally.
    room.index.insert(peer.userId, peer.position);
    const occ = this.occupancy(roomId);
    this.broadcaster.to(roomId).emit(ServerEvents.OccupancyUpdate, { roomId, ...occ });
    return result;
  }

  /** Returns a Promise (rather than being fire-and-forget) so callers that
   *  care about eviction actually completing — including a pending object
   *  flush — can await it; server.ts's disconnect handler does not need to
   *  and does not. */
  async removePeer(roomId: string, userId: string, expectedSocketId?: string): Promise<void> {
    const room = this.rooms.get(roomId);
    if (!room) return;

    // A disconnect from a socket the peer has since re-joined on (a browser
    // reconnect gets a NEW socket id, and admitAndAddPeer overwrites the
    // record with it) must not remove the live peer — the dead socket's ping
    // timeout can fire up to ~45s after the user is already back. Only checked
    // when the caller says which socket is disconnecting.
    if (expectedSocketId !== undefined) {
      const current = room.peers.get(userId);
      if (!current) return;
      if (current.socketId !== expectedSocketId) {
        this.staleDisconnectsIgnored++;
        return;
      }
    }

    // Unconditional, regardless of how many peers remain — evictRoom only
    // fires once the room is EMPTY, which a busy room may never reach, so
    // this is the only reliable place a leaked seat gets freed.
    this.releaseSeat(roomId, userId);

    room.peers.delete(userId);
    room.index.remove(userId);

    // Prune every cached pair-proximity state involving the departing peer,
    // in O(degree) via SparseProximityTracker.removeUser rather than the
    // O(all pairs ever seen) key scan Phase 8 needed. Without this, a
    // rejoining user with the same userId (e.g. after a reload) recomputes
    // an IDENTICAL proximity state against a peer who never left, so
    // change-detection sees no diff and never re-emits proximity:update —
    // the rejoining client silently never learns to subscribe to that
    // peer's audio. Also a straight memory leak otherwise.
    room.proximity.removeUser(userId);

    // Same leak/stale-cache class of bug as `proximity` above, for the
    // two zone-audio-specific maps: an untended zoneOf/usersByZone entry is
    // a memory leak, and a stale lastEmittedAudio entry for a departed user
    // could suppress a genuinely new emit to/from a same-named future
    // connection. Both are O(degree): `lastEmittedAudio` is now nested
    // (listener -> speaker -> state), so removing this user's own outer map
    // plus this user's key from every OTHER listener it appears under only
    // touches entries that actually reference it.
    const departedZoneId = room.zoneOf.get(userId) ?? null;
    room.zoneOf.delete(userId);
    if (departedZoneId) room.usersByZone.get(departedZoneId)?.delete(userId);

    // userId as LISTENER: drop their whole outer map, and unregister them
    // from every speaker's audience set (bounded by how many speakers THEY
    // were listening to — their own degree).
    const listenedTo = room.lastEmittedAudio.get(userId);
    if (listenedTo) {
      for (const speakerId of listenedTo.keys()) {
        room.audienceOf.get(speakerId)?.delete(userId);
      }
      room.lastEmittedAudio.delete(userId);
    }
    // userId as SPEAKER: `audienceOf` tells us exactly which listeners have
    // an entry for them, so this is O(degree) rather than O(all listeners).
    const audience = room.audienceOf.get(userId);
    if (audience) {
      for (const listenerId of audience) {
        room.lastEmittedAudio.get(listenerId)?.delete(userId);
      }
      room.audienceOf.delete(userId);
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
    /** Diagnostics only — see PeerState.lastMoveClientTs. Never used to
     *  validate; a client-supplied timestamp is a teleport vector. */
    clientTs?: number,
  ): ReturnType<typeof validateMove> | undefined {
    const room = this.rooms.get(roomId);
    const peer = room?.peers.get(userId);
    if (!room || !peer) return undefined;

    // A move from a seated peer is treated as an implicit stand-up — the
    // client stands up optimistically (see the approved plan) and may send
    // its next move before the corresponding seat:release arrives; release
    // is idempotent, so whichever order they arrive in is safe.
    this.releaseSeat(roomId, userId);

    const nowMs = Date.now();
    const result = validateMove(
      proposed,
      { position: peer.position, acceptedAtMs: peer.acceptedAtMs, creditMs: peer.moveCreditMs },
      nowMs,
      room.movementConfig,
    );

    // Phase 15 Part B, diagnostics only. Runs before acceptedAtMs is
    // overwritten below — elapsedMs and distancePx must describe the SAME
    // move that was just validated, on the SAME "since this user's last
    // accepted move" basis validateMove itself used.
    //
    // Every REJECTION is sampled; accepted moves 1-in-20. Rejections are
    // rare enough to keep whole, and testing whether they cluster at the
    // same instant across different users needs them dense — 1-in-20 would
    // thin a cluster into noise. Accepted moves only need to establish what
    // "normal" elapsed looks like, so a thin sample is enough there.
    this.moveSampleCounter++;
    const sampled = !result.accepted || this.moveSampleCounter % 20 === 0;
    if (sampled) {
      const elapsedMs = nowMs - peer.acceptedAtMs;
      const dx = proposed.x - peer.position.x;
      const dy = proposed.y - peer.position.y;
      const distancePx = Math.sqrt(dx * dx + dy * dy);
      const sample: MoveValidationSample = {
        elapsedMs,
        distancePx,
        // Floored at 1ms like validateMove's own denominator. An unfloored
        // elapsed of 0 would give Infinity, which JSON serialises as null —
        // blanking exactly the case this instrumentation exists to show.
        impliedSpeedPxPerSec: (distancePx / Math.max(elapsedMs, 1)) * 1000,
        serverGapMs: peer.lastMoveReceivedAtMs === undefined ? null : nowMs - peer.lastMoveReceivedAtMs,
        clientGapMs:
          clientTs === undefined || peer.lastMoveClientTs === undefined ? null : clientTs - peer.lastMoveClientTs,
        atMs: nowMs,
        userId,
      };
      const accepted = result.accepted;
      const target = accepted ? this.acceptedMoveSamples : this.rejectedMoveSamples;
      const cap = accepted ? RoomManager.MAX_ACCEPTED_MOVE_SAMPLES : RoomManager.MAX_REJECTED_MOVE_SAMPLES;
      target.push(sample);
      if (target.length > cap) target.shift();
    }
    if (!result.accepted) {
      const bucket = Math.floor(nowMs / 10);
      let users = this.windowRejectBuckets.get(bucket);
      if (!users) {
        users = new Set();
        this.windowRejectBuckets.set(bucket, users);
      }
      users.add(userId);
    }
    peer.lastMoveReceivedAtMs = nowMs;
    if (clientTs !== undefined) peer.lastMoveClientTs = clientTs;

    if (result.accepted) {
      peer.position = result.position;
      peer.acceptedAtMs = nowMs;
      peer.moveCreditMs = result.nextCreditMs;
      room.index.move(userId, peer.position);
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
      // A teleport starts a fresh movement window: banked credit must not
      // let a stale queued move be validated against extra allowance.
      peer.moveCreditMs = 0;
      room.index.move(userId, peer.position);
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
   *  state for a pair — lets tests assert directly that the tracker was
   *  never corrupted by a zone audio override, the same spirit as
   *  runTickForTest above. Production code never calls this. Returns
   *  undefined for a pair the sparse tracker doesn't store, which — unlike
   *  Phase 8's full-pair Map — includes every genuinely far-apart pair; a
   *  caller wanting the effective NOT_NEARBY default should treat undefined
   *  as NOT_NEARBY, matching how the tick body itself reads this state. */
  proximityStateForTest(roomId: string, a: string, b: string): ProximityState | undefined {
    return this.rooms.get(roomId)?.proximity.stateFor(a, b);
  }

  /** Rolling per-tick duration samples across every room this instance owns
   *  — an instance-wide health signal, not per-room, since what the load
   *  harness (see the plan's final step) cares about is how the ONE process
   *  handling N concurrent connections is doing overall. Exposed via
   *  getTickStats() -> server.ts's /internal/metrics. A fixed-size circular
   *  buffer (write index wraps) rather than push+shift — shift() is O(n)
   *  per call, which would itself become a per-tick cost at scale. */
  private static readonly MAX_TICK_SAMPLES = 200;
  private readonly tickDurationsMs: number[] = [];
  private tickWriteIndex = 0;
  /** Per-tick candidate-pair-check count, same rolling-sample treatment as
   *  tick duration — lets /internal/metrics report how much the spatial
   *  index is actually cutting the naive O(n^2) pair count down to. */
  private readonly tickPairCounts: number[] = [];
  /** Per-tick count of proximity:update emits actually sent (post
   *  gain-threshold suppression) — reports real emit volume, the other half
   *  of Phase 9's optimization besides pair-check count. */
  private readonly tickEmitCounts: number[] = [];
  private tickEmitCountThisTick = 0;
  /** Phase 10: per-phase breakdown of the same tick, so "emission is
   *  dominant" is a measured claim, not a guess. Same ring-buffer treatment
   *  as tickDurationsMs, sharing its write index (all five arrays are
   *  always recorded together, once per tick — see tick() below). */
  private readonly tickPositionsMs: number[] = [];
  private readonly tickProximityPhaseMs: number[] = [];
  private readonly tickZoneMs: number[] = [];
  private readonly tickAudioEmitMs: number[] = [];

  private recordSample(buffer: number[], value: number): void {
    if (buffer.length < RoomManager.MAX_TICK_SAMPLES) {
      buffer.push(value);
    } else {
      buffer[this.tickWriteIndex % RoomManager.MAX_TICK_SAMPLES] = value;
    }
  }

  private static percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)]!;
  }

  /** Rolling tick-duration/pair-count/emit-count stats for /internal/metrics.
   *  p50/p95/p99 are computed here (on read), never per tick, from a sorted
   *  COPY of the ring buffer — sorting 200 numbers on an occasional metrics
   *  poll is negligible; doing it every 100ms tick would not be. Empty stats
   *  (all zero) before the first tick has run. */
  /** Summarizes one phase's ring buffer the same way the overall duration
   *  is summarized — avg/p50/p95/p99, zeros before any sample exists. */
  private static summarize(samples: number[]): { avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number } {
    if (samples.length === 0) return { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    return {
      avgMs: sum / samples.length,
      p50Ms: RoomManager.percentile(sorted, 50),
      p95Ms: RoomManager.percentile(sorted, 95),
      p99Ms: RoomManager.percentile(sorted, 99),
    };
  }

  getTickStats(): {
    sampleCount: number;
    avgMs: number;
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    avgPairChecks: number;
    avgEmits: number;
    phases: {
      positions: { avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number };
      proximity: { avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number };
      zone: { avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number };
      audioEmit: { avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number };
    };
  } {
    const samples = this.tickDurationsMs;
    const emptyPhase = { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
    if (samples.length === 0) {
      return {
        sampleCount: 0,
        avgMs: 0,
        maxMs: 0,
        p50Ms: 0,
        p95Ms: 0,
        p99Ms: 0,
        avgPairChecks: 0,
        avgEmits: 0,
        phases: { positions: emptyPhase, proximity: emptyPhase, zone: emptyPhase, audioEmit: emptyPhase },
      };
    }
    const sorted = [...samples].sort((a, b) => a - b);
    const sum = samples.reduce((a, b) => a + b, 0);
    const pairSum = this.tickPairCounts.reduce((a, b) => a + b, 0);
    const emitSum = this.tickEmitCounts.reduce((a, b) => a + b, 0);
    return {
      sampleCount: samples.length,
      avgMs: sum / samples.length,
      maxMs: Math.max(...samples),
      p50Ms: RoomManager.percentile(sorted, 50),
      p95Ms: RoomManager.percentile(sorted, 95),
      p99Ms: RoomManager.percentile(sorted, 99),
      avgPairChecks: this.tickPairCounts.length > 0 ? pairSum / this.tickPairCounts.length : 0,
      avgEmits: this.tickEmitCounts.length > 0 ? emitSum / this.tickEmitCounts.length : 0,
      phases: {
        positions: RoomManager.summarize(this.tickPositionsMs),
        proximity: RoomManager.summarize(this.tickProximityPhaseMs),
        zone: RoomManager.summarize(this.tickZoneMs),
        audioEmit: RoomManager.summarize(this.tickAudioEmitMs),
      },
    };
  }

  private tick(roomId: string): void {
    const start = performance.now();
    this.tickEmitCountThisTick = 0;
    this.diagnostics?.beginTick();
    let phases: TickPhaseTimings | undefined;
    let emitTick: { emitCount: number; emitMs: number } | undefined;
    try {
      phases = this.tickBody(roomId);
    } finally {
      // Always closed, even if the tick throws, so the recorder never stays
      // stuck "inside a tick".
      emitTick = this.diagnostics?.endTick();
    }
    this.recordSample(this.tickDurationsMs, performance.now() - start);
    this.recordSample(this.tickPairCounts, this.tickPairCount);
    this.recordSample(this.tickEmitCounts, this.tickEmitCountThisTick);
    if (phases) {
      this.recordSample(this.tickPositionsMs, phases.positionsMs);
      this.recordSample(this.tickProximityPhaseMs, phases.proximityMs);
      this.recordSample(this.tickZoneMs, phases.zoneMs);
      this.recordSample(this.tickAudioEmitMs, phases.audioEmitMs);
    }
    this.tickWriteIndex++;
    const sample = this.recordTickWindow(performance.now() - start, emitTick);
    if (this.diagnostics && sample) {
      // One immediate per tick, self-terminating: it fires once in this loop
      // iteration's check phase, after the poll phase has processed whatever
      // I/O the tick left queued, and records how long that took.
      setImmediate(() => {
        sample.postTickMs = performance.now() - sample.atMs;
      });
    }
  }

  private recordTickWindow(
    tickMs: number,
    emitTick: { emitCount: number; emitMs: number } | undefined,
  ): TickWindowSample | undefined {
    const wallMs = performance.now();
    const cpuUsage = process.cpuUsage();
    const elu = performance.eventLoopUtilization();
    const prev = this.windowBaseline;
    const buckets = this.windowRejectBuckets;
    this.windowRejectBuckets = new Map();
    this.windowBaseline = { wallMs, cpuUsage, elu };
    if (!prev) return undefined;

    const windowMs = wallMs - prev.wallMs;
    const cpuMs = (cpuUsage.user - prev.cpuUsage.user + (cpuUsage.system - prev.cpuUsage.system)) / 1000;
    let maxClusterUsers = 0;
    for (const users of buckets.values()) maxClusterUsers = Math.max(maxClusterUsers, users.size);
    const sample: TickWindowSample = {
      atMs: wallMs,
      windowMs,
      elu: performance.eventLoopUtilization(elu, prev.elu).utilization,
      cpuWallRatio: windowMs > 0 ? cpuMs / windowMs : 0,
      tickMs,
      maxClusterUsers,
      emitCount: emitTick?.emitCount ?? 0,
      emitMs: emitTick?.emitMs ?? 0,
      postTickMs: null,
    };
    if (this.tickWindows.length < RoomManager.MAX_TICK_WINDOWS) {
      this.tickWindows.push(sample);
    } else {
      this.tickWindows[this.tickWindowWriteIndex % RoomManager.MAX_TICK_WINDOWS] = sample;
    }
    this.tickWindowWriteIndex++;
    return sample;
  }

  private tickBody(roomId: string): TickPhaseTimings | undefined {
    const room = this.rooms.get(roomId);
    if (!room || room.peers.size === 0) return undefined;

    const phaseStart = performance.now();

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

    const afterPositions = performance.now();

    // Proximity: only candidate pairs from the spatial index are checked
    // (see UniformGridIndex's doc comment for why that's still exhaustive
    // for every pair that could possibly be non-NOT_NEARBY). `room.proximity`
    // stores exactly this RAW output — never a zone-overridden value.
    // Writing an override back in here would corrupt computeProximityState's
    // hysteresis, since it reads this cache as its own "wasAudio"/
    // "wasVideo" baseline next tick — a zone-forced full-gain pair would
    // then get an undeserved +hysteresisPx grace band the moment distance
    // alone is checked again, e.g. right after leaving the zone.
    const rawChangedPairs: [string, string][] = [];
    this.tickPairCount = 0;
    room.proximity.tick(room.index, DEFAULT_PROXIMITY_CONFIG, (a, b) => {
      rawChangedPairs.push([a, b]);
    });

    const afterProximity = performance.now();

    // Zone membership: diffed independently every tick, because raw
    // proximity above only reports pairs whose DISTANCE changed — two
    // people already standing still together when one crosses into a
    // meeting room produces zero distance change and would otherwise emit
    // nothing, even though what they can hear just changed completely.
    // `usersByZone` is kept in lockstep with `zoneOf` here so the candidate
    // step below can look up "everyone in zone X" in O(zone size) instead
    // of O(all peers in the room).
    const zoneChanges: { userId: string; previousZoneId: string | null; newZoneId: string | null }[] = [];
    for (const peer of room.peers.values()) {
      const zone = zoneAt(room.layout, peer.position);
      const zoneId = zone?.id ?? null;
      const previousZoneId = room.zoneOf.get(peer.userId) ?? null;
      if (zoneId !== previousZoneId) {
        room.zoneOf.set(peer.userId, zoneId);
        if (previousZoneId) room.usersByZone.get(previousZoneId)?.delete(peer.userId);
        if (zoneId) {
          let members = room.usersByZone.get(zoneId);
          if (!members) {
            members = new Set();
            room.usersByZone.set(zoneId, members);
          }
          members.add(peer.userId);
        }
        zoneChanges.push({ userId: peer.userId, previousZoneId, newZoneId: zoneId });
        this.broadcaster.to(peer.socketId).emit(ServerEvents.ZoneChanged, {
          zone: zone ? { id: zone.id, label: zone.label, kind: zone.kind } : null,
        });
      }
    }

    // Candidate pairs for a directed audio re-check = every pair whose raw
    // distance-state changed, UNION (for every user whose zone just
    // changed) their grid neighbours ∪ their old/new zone's counterpart
    // members (same-zone or linked stage/audience — see
    // zoneRecheckCounterparts's docs, this is what makes a far-apart
    // stage<->audience or same-meeting-room pair re-check even though
    // they're nowhere near each other in the grid) ∪ every pair this user
    // already has a directed lastEmittedAudio entry for in EITHER direction
    // (so a revert-to-raw/muted is still caught even if none of the above
    // would otherwise flag it).
    const candidatePairs = new Set<string>();
    for (const [a, b] of rawChangedPairs) candidatePairs.add(pairKey(a, b));

    for (const { userId, previousZoneId, newZoneId } of zoneChanges) {
      for (const otherId of room.proximity.neighborsOf(userId)) {
        candidatePairs.add(pairKey(userId, otherId));
      }
      for (const otherId of this.zoneRecheckCounterparts(room, previousZoneId)) {
        if (otherId !== userId) candidatePairs.add(pairKey(userId, otherId));
      }
      for (const otherId of this.zoneRecheckCounterparts(room, newZoneId)) {
        if (otherId !== userId) candidatePairs.add(pairKey(userId, otherId));
      }
      for (const speakerId of room.lastEmittedAudio.get(userId)?.keys() ?? []) {
        candidatePairs.add(pairKey(userId, speakerId));
      }
      for (const listenerId of room.audienceOf.get(userId) ?? []) {
        candidatePairs.add(pairKey(userId, listenerId));
      }
    }

    const zoneRefFor = (userId: string): ZoneRef | null => {
      const zoneId = room.zoneOf.get(userId);
      if (!zoneId) return null;
      const zone = zoneById(room.layout, zoneId);
      return zone ? { id: zone.id, kind: zone.kind, stageId: zone.stageId } : null;
    };

    const afterZone = performance.now();

    this.tickPairCount = candidatePairs.size;
    for (const key of candidatePairs) {
      const [a, b] = key.split(":") as [string, string];
      if (!room.peers.has(a) || !room.peers.has(b)) continue; // one side left this tick

      // A pair with no stored raw entry is genuinely NOT_NEARBY — the sparse
      // tracker (unlike Phase 8's full-pair Map) never stores that state,
      // so "missing" and "NOT_NEARBY" mean the same thing here.
      const raw = room.proximity.stateFor(a, b) ?? NOT_NEARBY;

      const zoneA = zoneRefFor(a);
      const zoneB = zoneRefFor(b);

      this.maybeEmitDirectedAudio(room, a, b, effectiveAudio(raw, zoneA, zoneB));
      this.maybeEmitDirectedAudio(room, b, a, effectiveAudio(raw, zoneB, zoneA));
    }

    const afterAudioEmit = performance.now();

    return {
      positionsMs: afterPositions - phaseStart,
      proximityMs: afterProximity - afterPositions,
      zoneMs: afterZone - afterProximity,
      audioEmitMs: afterAudioEmit - afterZone,
    };
  }

  /** Every user a directed audio re-check must also consider for `zoneId`,
   *  beyond plain grid neighbours — the "distance doesn't matter" half of
   *  the zone-audio rules (see packages/proximity/src/zoneAudio.ts):
   *  - a stage zone's counterparts are every member of every audience zone
   *    linked to it (an audience always hears its stage at full gain,
   *    however far away the speaker physically is)
   *  - an audience zone's counterpart is its linked stage's members
   *  - a meeting/cabin/open/focus zone's counterpart is its OWN other
   *    members (same-zone full gain, or focus's same-zone mute, applies
   *    regardless of physical distance within the zone)
   *  Returns an empty set for a null zoneId or a zone kind with no
   *  distance-independent rule (e.g. lobby), since grid neighbours already
   *  cover those correctly via raw proximity. */
  private zoneRecheckCounterparts(
    room: NonNullable<ReturnType<RoomManager["rooms"]["get"]>>,
    zoneId: string | null,
  ): ReadonlySet<string> {
    if (!zoneId) return EMPTY_USER_SET;
    const zone = zoneById(room.layout, zoneId);
    if (!zone) return EMPTY_USER_SET;

    if (zone.kind === "stage") {
      const result = new Set<string>();
      for (const z of room.layout.zones) {
        if (z.kind === "audience" && z.stageId === zone.id) {
          for (const u of room.usersByZone.get(z.id) ?? EMPTY_USER_SET) result.add(u);
        }
      }
      return result;
    }
    if (zone.kind === "audience" && zone.stageId) {
      return room.usersByZone.get(zone.stageId) ?? EMPTY_USER_SET;
    }
    if (zone.kind === "meeting" || zone.kind === "cabin" || zone.kind === "open" || zone.kind === "focus") {
      return room.usersByZone.get(zone.id) ?? EMPTY_USER_SET;
    }
    return EMPTY_USER_SET;
  }

  /** Last per-tick candidate-pair count, across whichever room ticked most
   *  recently — instance-wide load signal for /internal/metrics, the same
   *  spirit as tickDurationsMs below. Not room-keyed for the same reason
   *  tick timing isn't: the load harness cares about instance-wide health. */
  private tickPairCount = 0;

  /** Emits proximity:update to `listenerUserId` about `speakerUserId` only
   *  if the EFFECTIVE (post zone-override) state differs enough from what
   *  was last sent for this exact direction to matter — dedup lives here,
   *  keyed separately per direction, since a stage/audience pair (or any
   *  private zone pairing) is asymmetric by design.
   *
   *  A subscribe/unsubscribe edge or a gain reaching exactly 0 or 1 always
   *  emits; a pure gain WOBBLE below GAIN_EMIT_THRESHOLD is suppressed to
   *  cut emit volume under real walking (this is the one intentional
   *  behavior change from Phase 8 — the client already smooths gain, so a
   *  <2% step is inaudible). Suppressing an emit deliberately does NOT
   *  update `lastEmittedAudio`, so small steps accumulate against the last
   *  ACTUALLY-SENT value rather than being lost one comparison at a time. */
  private maybeEmitDirectedAudio(
    room: NonNullable<ReturnType<RoomManager["rooms"]["get"]>>,
    listenerUserId: string,
    speakerUserId: string,
    state: ProximityState,
  ): void {
    const previous = room.lastEmittedAudio.get(listenerUserId)?.get(speakerUserId);
    if (previous && !shouldEmitAudioChange(previous, state)) return;

    if (state.audioSubscribed) {
      let bySpeaker = room.lastEmittedAudio.get(listenerUserId);
      if (!bySpeaker) {
        bySpeaker = new Map();
        room.lastEmittedAudio.set(listenerUserId, bySpeaker);
      }
      bySpeaker.set(speakerUserId, state);

      let audience = room.audienceOf.get(speakerUserId);
      if (!audience) {
        audience = new Set();
        room.audienceOf.set(speakerUserId, audience);
      }
      audience.add(listenerUserId);
    } else {
      // Back to NOT_NEARBY — drop the stored entry (and its reverse-index
      // registration) rather than keep a permanent record of every pair
      // that ever came near each other.
      room.lastEmittedAudio.get(listenerUserId)?.delete(speakerUserId);
      room.audienceOf.get(speakerUserId)?.delete(listenerUserId);
    }

    const listenerSocketId = room.peers.get(listenerUserId)?.socketId;
    if (listenerSocketId) {
      this.broadcaster.to(listenerSocketId).emit(ServerEvents.ProximityUpdate, { peerId: speakerUserId, ...state });
      this.tickEmitCountThisTick++;
    }
  }

  /** Rooms whose eviction is in flight (awaiting the object flush). The record
   *  stays in `this.rooms` for that whole time — the flush reads pending
   *  objects through it — so without this a join could take the fast path
   *  into a room that is deleted moments later, with its timers already
   *  cleared. A second evictRoom for the same room joins the in-flight one. */
  private readonly evictions = new Map<string, Promise<void>>();

  /** Resolves once any in-flight eviction of this room has completed (or
   *  immediately if there is none). join_room's slow path awaits this before
   *  ensureRoom, which would otherwise no-op on the doomed record. Never
   *  rejects: another room's flush failure is not this join's problem. */
  awaitEviction(roomId: string): Promise<void> {
    return (this.evictions.get(roomId) ?? Promise.resolve()).catch(() => {});
  }

  private evictRoom(roomId: string, opts: { notifyOwnerChanged: boolean }): Promise<void> {
    const inFlight = this.evictions.get(roomId);
    if (inFlight) return inFlight;
    if (!this.rooms.has(roomId)) return Promise.resolve();

    const run = this.runEviction(roomId, opts).finally(() => this.evictions.delete(roomId));
    this.evictions.set(roomId, run);
    return run;
  }

  private async runEviction(roomId: string, opts: { notifyOwnerChanged: boolean }): Promise<void> {
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
    return this.rooms.has(roomId) && !this.evictions.has(roomId);
  }

  /** Phase 11 Part B: everything join_room needs about a room it ALREADY
   *  owns, without re-deriving any of it. While isOwnedLocally(roomId) is
   *  true, the lease-refresh timer (see ensureRoom) is the thing keeping
   *  ownership current — a second join doesn't need its own Redis round trip
   *  to confirm what the timer is already confirming every
   *  leaseRefreshIntervalMs. Same reasoning for participantLimit/layout/
   *  movementConfig: they were already resolved on the first join (or the
   *  last plan-limit refresh) and stored here specifically so they don't
   *  need to be looked up again per joiner. Returns null for a room this
   *  instance doesn't own, so callers fall back to the full claim path. */
  getRoomInfo(
    roomId: string,
  ): { workspaceId: string; layout: RoomLayout; movementConfig: MovementConfig; participantLimit: number } | null {
    const room = this.rooms.get(roomId);
    if (!room || this.evictions.has(roomId)) return null;
    return {
      workspaceId: room.workspaceId,
      layout: room.layout,
      movementConfig: room.movementConfig,
      participantLimit: room.participantLimit,
    };
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
