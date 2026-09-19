import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { resolveRoomEndpoint } from "@cosmos/realtime-core";
import {
  ClientEvents,
  ServerEvents,
  JoinRoomEventSchema,
  MoveEventSchema,
  ObjectUpsertEventSchema,
  ObjectDeleteEventSchema,
  SeatClaimEventSchema,
  SeatReleaseEventSchema,
  parseRoomConfig,
  resolveLayout,
  DEFAULT_LAYOUT_ID,
  zoneById,
  tileRectCenter,
  movementConfigForLayout,
  DEFAULT_MOVEMENT_CONFIG,
  type PeersSnapshotEvent,
  type ObjectsSnapshotEvent,
  type SeatsSnapshotEvent,
  type RoomLayout,
  type MovementConfig,
} from "@cosmos/shared";
import { loadRoomObjects, upsertObject, deleteObject, planParticipantLimitProvider, transientRetryStats } from "@cosmos/db";
import type { ParticipantLimitProvider } from "@cosmos/shared";
import { env } from "./env";
import {
  instanceId,
  redisPub,
  redisSub,
  roomLease,
  instanceRegistry,
  startHeartbeat,
  stopHeartbeat,
  redisPublishStats,
} from "./instance";
import { verifySessionToken, assertRoomMembership, assertWorkspaceMembership } from "./auth";
import { RoomManager, broadcasterFromSocketServer } from "./roomManager";
import { CountingBroadcaster } from "./countingBroadcaster";
import { maybeRegisterLoadHarnessRoutes } from "./loadHarnessRoutes";
import { provisionLoadHarnessWorkspace, teardownLoadHarnessWorkspace } from "./loadHarnessFixtures";
import { spawnPositionForUser } from "@cosmos/proximity";

const app = Fastify({ logger: true });

/**
 * Dev/load-testing-only override of the plan-resolved participant limit —
 * lets the load harness (see the Phase 9 plan's final step) exercise a
 * ceiling above Enterprise's 200 without touching a single plan limit or
 * advertising a higher tier anywhere in the product. Guarded on BOTH the env
 * var's presence AND `NODE_ENV !== "production"`, so it is structurally
 * inert in a production deployment even if the env var were ever set there
 * by mistake — this must never become a real capacity lever.
 */
const loadHarnessLimitOverride: ParticipantLimitProvider =
  process.env.NODE_ENV !== "production" && process.env.LOAD_HARNESS_LIMIT_OVERRIDE
    ? {
        async getWorkspaceParticipantLimit(workspaceId) {
          const override = Number(process.env.LOAD_HARNESS_LIMIT_OVERRIDE);
          if (Number.isInteger(override) && override > 0) return override;
          return planParticipantLimitProvider.getWorkspaceParticipantLimit(workspaceId);
        },
      }
    : planParticipantLimitProvider;

app.get("/health", async () => ({ ok: true, instanceId }));

// Dev/testing convenience: exercises the exact same resolveRoomEndpoint path
// the Next.js `GET /api/rooms/:id/endpoint` handler will call in apps/web.
// Picks uniformly at random among currently live instances as the candidate.
app.get<{ Params: { roomId: string } }>("/internal/resolve-room/:roomId", async (req, reply) => {
  try {
    const endpoint = await resolveRoomEndpoint(
      req.params.roomId,
      roomLease,
      instanceRegistry,
      async () => {
        const ids = await instanceRegistry.listActiveIds();
        if (ids.length === 0) return null;
        return ids[Math.floor(Math.random() * ids.length)]!;
      },
    );
    return endpoint;
  } catch (err) {
    reply.code(503);
    return { error: (err as Error).message };
  }
});

// Declared before roomManager/countingBroadcaster exist (Fastify locks route
// registration after listen() starts accepting connections) and assigned
// right after — the handler closes over these bindings, not values, so it
// sees the real instances by the time any request actually arrives. Dev/
// load-testing convenience only: reports this process's own tick-timing,
// memory, CPU, event-loop and emit-volume health under load (see the Phase
// 9/10 plans' load harness steps), never called by production application code.
let roomManager: RoomManager;
let countingBroadcaster: CountingBroadcaster;

// Event-loop delay histogram — Phase 10's L4 lead (the move:correction
// storm under load "fits event-loop stalls", but that was never measured).
// resolution 10ms is more than fine for spotting stalls in the tens-to-
// thousands-of-ms range this investigation cares about. Reset on every
// /internal/metrics read so each read reports the window since the last one,
// the same "since last read" contract process.cpuUsage() deltas use below.
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
eventLoopDelay.enable();

// CPU and emit-rate metrics are both "since the last /internal/metrics
// read" deltas, mirroring process.cpuUsage()'s own delta-argument contract
// — a single point-in-time cumulative number is far less useful under load
// than "how much CPU / how many emits happened in the last N seconds".
let lastMetricsReadAt = process.hrtime.bigint();
let lastCpuUsage = process.cpuUsage();
let lastEmitSnapshot: Record<string, { count: number; sampledCount: number; sampledBytesSum: number }> = {};
let lastRedisPublishCount = 0;

/** Phase 11 Part C: server-side join_room timing, so a load test's observed
 *  latency (which also includes the client<->server round trip, e.g. a
 *  relayed port-forward) can be separated from what the handler itself
 *  actually costs. Same fixed-size ring-buffer treatment as RoomManager's
 *  tick-timing samples, for the same reason: bounded memory under sustained
 *  load, no shift()-per-call cost. */
class RollingMsStats {
  private static readonly MAX_SAMPLES = 500;
  private readonly samples: number[] = [];
  private writeIndex = 0;

  record(ms: number): void {
    if (this.samples.length < RollingMsStats.MAX_SAMPLES) {
      this.samples.push(ms);
    } else {
      this.samples[this.writeIndex % RollingMsStats.MAX_SAMPLES] = ms;
    }
    this.writeIndex++;
  }

  snapshot(): { sampleCount: number; avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number } {
    if (this.samples.length === 0) return { sampleCount: 0, avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0 };
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
    return {
      sampleCount: sorted.length,
      avgMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
      p50Ms: pct(50),
      p95Ms: pct(95),
      p99Ms: pct(99),
    };
  }
}
const joinDuration = new RollingMsStats();

app.get("/internal/metrics", async () => {
  const now = process.hrtime.bigint();
  const elapsedSeconds = Number(now - lastMetricsReadAt) / 1e9;
  lastMetricsReadAt = now;

  const cpuUsage = process.cpuUsage(lastCpuUsage);
  lastCpuUsage = process.cpuUsage();
  // cpuUsage() fields are microseconds; %-of-one-core = usedMicros / elapsedMicros * 100.
  const elapsedMicros = Math.max(1, elapsedSeconds * 1e6);
  const cpuPercent = {
    user: (cpuUsage.user / elapsedMicros) * 100,
    system: (cpuUsage.system / elapsedMicros) * 100,
  };

  const eventLoop = {
    p50Ms: eventLoopDelay.percentile(50) / 1e6,
    p99Ms: eventLoopDelay.percentile(99) / 1e6,
    maxMs: eventLoopDelay.max / 1e6,
  };
  eventLoopDelay.reset();

  const emitSnapshot = countingBroadcaster.snapshot();
  const emitRates: Record<string, { emitsPerSec: number; avgBytesPerEmit: number; bytesPerSecEstimate: number }> = {};
  for (const [event, stat] of Object.entries(emitSnapshot)) {
    const previous = lastEmitSnapshot[event];
    const deltaCount = stat.count - (previous?.count ?? 0);
    const deltaSampledCount = stat.sampledCount - (previous?.sampledCount ?? 0);
    const deltaSampledBytes = stat.sampledBytesSum - (previous?.sampledBytesSum ?? 0);
    const avgBytesPerEmit = deltaSampledCount > 0 ? deltaSampledBytes / deltaSampledCount : 0;
    emitRates[event] = {
      emitsPerSec: elapsedSeconds > 0 ? deltaCount / elapsedSeconds : 0,
      avgBytesPerEmit,
      bytesPerSecEstimate: elapsedSeconds > 0 ? (avgBytesPerEmit * deltaCount) / elapsedSeconds : 0,
    };
  }
  lastEmitSnapshot = emitSnapshot;

  const redisPublishDelta = redisPublishStats.count - lastRedisPublishCount;
  lastRedisPublishCount = redisPublishStats.count;
  const redisPublishesPerSec = elapsedSeconds > 0 ? redisPublishDelta / elapsedSeconds : 0;

  return {
    instanceId,
    uptimeSeconds: process.uptime(),
    memoryUsage: process.memoryUsage(),
    tick: roomManager.getTickStats(),
    cpuPercent,
    eventLoop,
    emitRates,
    redisPublishesPerSec,
    lease: roomManager.getLeaseStats(),
    join: joinDuration.snapshot(),
    transientDbRetryAttempts: transientRetryStats.attempts,
  };
});

if (
  maybeRegisterLoadHarnessRoutes(app, process.env, {
    provision: provisionLoadHarnessWorkspace,
    teardown: teardownLoadHarnessWorkspace,
    // Closes over the `let roomManager` binding declared above, not a
    // value — same trick /internal/metrics uses, since roomManager isn't
    // constructed until after app.listen() below.
    getOccupancy: (roomId) => roomManager.occupancy(roomId),
  })
) {
  app.log.warn("LOAD_HARNESS_ENABLED=1: /internal/load-harness/* fixture routes are active (dev/test only)");
}

await app.listen({ port: env.port, host: "0.0.0.0" });

const io = new SocketIOServer(app.server, {
  cors: { origin: "*" }, // tighten to the web app's origin before production
  adapter: createAdapter(redisPub, redisSub),
});

countingBroadcaster = new CountingBroadcaster(broadcasterFromSocketServer(io));
roomManager = new RoomManager(countingBroadcaster, roomLease, instanceId, 10_000, {
  loadRoomObjects,
  upsertObject,
  deleteObject,
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error("Missing session token."));

  try {
    socket.data.user = verifySessionToken(token, env.authSecret);
    next();
  } catch {
    next(new Error("Invalid session token."));
  }
});

io.on("connection", (socket) => {
  const user = socket.data.user as { userId: string; email: string };

  socket.on(ClientEvents.JoinRoom, async (raw, ack?: (res: unknown) => void) => {
    const joinStartedAt = performance.now();
    const finish = (res: unknown) => {
      joinDuration.record(performance.now() - joinStartedAt);
      return ack?.(res);
    };

    const parsed = JoinRoomEventSchema.safeParse(raw);
    if (!parsed.success) return finish({ error: "Invalid join payload." });

    const { roomId } = parsed.data;

    let workspaceId: string;
    let layout: RoomLayout;
    let movementConfig: MovementConfig;
    let limit: number;

    // Fast path: this instance already owns the room. Every answer below is
    // already known — the lease-refresh timer (roomManager.ts's
    // ensureRoom) is what keeps `isOwnedLocally` true, so a second join
    // doesn't need its own Redis round trip to reconfirm ownership, its own
    // Room lookup to learn workspaceId/layout, or its own participant-limit
    // query; RoomManager cached all three the first time this room was
    // ensured. Only the per-USER membership check can't be skipped or
    // cached — it must be re-verified for every joiner.
    const cached = roomManager.getRoomInfo(roomId);
    if (cached) {
      try {
        await assertWorkspaceMembership(user.userId, cached.workspaceId);
      } catch (err) {
        return finish({ error: (err as Error).message });
      }
      workspaceId = cached.workspaceId;
      layout = cached.layout;
      movementConfig = cached.movementConfig;
      limit = cached.participantLimit;
      // hydrateObjects is a memoized no-op after the room's first join (see
      // its docs) — still awaited so a joiner is never sent an incomplete
      // objects:snapshot, but it resolves an already-settled promise here.
      await roomManager.hydrateObjects(roomId);
    } else {
      // Slow path: first joiner for a room this instance doesn't yet own.
      let roomConfig: unknown;
      try {
        ({ workspaceId, config: roomConfig } = await assertRoomMembership(user.userId, roomId));
      } catch (err) {
        return finish({ error: (err as Error).message });
      }

      // Resolved from Room.config, falling back to the default layout for a
      // missing/unknown id — the identical rule the room page applies
      // client-side, so client and server always agree on floor bounds and
      // the spawn point (see @cosmos/shared's layouts module).
      const { layoutId } = parseRoomConfig(roomConfig);
      layout = resolveLayout(layoutId) ?? resolveLayout(DEFAULT_LAYOUT_ID)!;
      movementConfig = movementConfigForLayout(layout, DEFAULT_MOVEMENT_CONFIG);

      // Claim-or-confirm ownership. This is the guard against a split room:
      // if this instance is not (or is no longer) the authoritative owner,
      // refuse the join and tell the client to re-resolve its endpoint from
      // scratch — never silently serve a second copy of the room's state.
      const owner = await roomLease.claimOrRead(instanceId, roomId);
      if (owner !== instanceId) {
        socket.emit(ServerEvents.OwnerChanged, { roomId });
        return finish({ error: "not_owner", roomId });
      }

      roomManager.ensureRoom(roomId, workspaceId, movementConfig, layout);

      // Independent of each other (hydration reads only roomId; the limit
      // lookup reads only workspaceId) — no data dependency, so they run
      // concurrently instead of one queuing behind the other's round trip.
      // hydrateObjects must still complete before any object read/mutation
      // for this room, including this very join's objects:snapshot below —
      // otherwise a joining client could be sent an incomplete (still-
      // loading) object list. Concurrent joins for the same room all await
      // the same in-flight load rather than racing separate ones (see
      // RoomManager.hydrateObjects's docs).
      [, limit] = await Promise.all([
        roomManager.hydrateObjects(roomId),
        // Resolved from Workspace.plan today; a future billing system swaps
        // only this provider (see ParticipantLimitProvider in
        // @cosmos/shared) — the rest of this flow is unaffected.
        loadHarnessLimitOverride.getWorkspaceParticipantLimit(workspaceId),
      ]);
    }

    const spawnZone = zoneById(layout, layout.spawnZoneId)!;

    // admitAndAddPeer checks capacity and inserts the peer in one synchronous
    // call, so two sockets racing for the last slot can't both be admitted.
    // Rejected: do NOT join the socket to the room and do not broadcast
    // anything — nothing about the room's state changes for a refused join.
    const admission = roomManager.admitAndAddPeer(roomId, {
      userId: user.userId,
      name: user.email, // placeholder until profile data is wired up in phase 2
      avatarUrl: null,
      socketId: socket.id,
      // Deterministic per-user ring offset around the layout's spawn zone
      // center, so multiple avatars don't render exactly on top of each
      // other (see packages/proximity/src/spawn.ts). Closes the TODO this
      // used to carry — Room.config is now read above via assertRoomMembership.
      position: spawnPositionForUser(user.userId, tileRectCenter(spawnZone.rect), undefined, movementConfig),
    }, limit);

    if (!admission.admitted) {
      return finish({ error: "workspace_full", limit: admission.limit, active: admission.active });
    }

    await socket.join(roomId);
    socket.data.roomId = roomId;

    // Broadcast to the whole room, not just this socket: existing peers
    // otherwise only ever learn of a newcomer via peers:delta, which carries
    // no name/avatar, so they'd render the newcomer permanently unnamed.
    // This also doubles as the client's clean-resync primitive on reconnect,
    // and (via active/limit) how everyone's occupancy display stays current
    // on the join path — see OccupancyUpdateEventSchema for the leave path.
    const occ = roomManager.occupancy(roomId);
    const snapshot: PeersSnapshotEvent = { roomId, peers: roomManager.snapshot(roomId), ...occ };
    io.to(roomId).emit(ServerEvents.PeersSnapshot, snapshot);

    // Objects:snapshot goes to the JOINING socket only, unlike peers:snapshot
    // — an existing peer's knowledge of the room's objects doesn't change
    // just because someone else joined (nothing about the peer itself
    // changed), whereas peers:snapshot also doubles as how existing peers
    // learn the newcomer's identity.
    const objectsSnapshot: ObjectsSnapshotEvent = { roomId, objects: roomManager.objectsSnapshot(roomId) };
    socket.emit(ServerEvents.ObjectsSnapshot, objectsSnapshot);

    // Same joiner-only rule as objects:snapshot, for the same reason: an
    // existing peer's knowledge of who's seated where doesn't change just
    // because someone else joined.
    const seatsSnapshot: SeatsSnapshotEvent = { roomId, occupancy: roomManager.seatsSnapshot(roomId) };
    socket.emit(ServerEvents.SeatsSnapshot, seatsSnapshot);

    finish({ ok: true });
  });

  socket.on(ClientEvents.Move, (raw) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;

    const parsed = MoveEventSchema.safeParse(raw);
    if (!parsed.success) return;

    const result = roomManager.applyMove(roomId, user.userId, parsed.data.position);
    if (result && !result.accepted) {
      socket.emit(ServerEvents.MoveCorrection, {
        position: result.correctedPosition,
        reason: result.reason,
      });
    }
  });

  socket.on(ClientEvents.SeatClaim, (raw, ack?: (res: unknown) => void) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return ack?.({ error: "not_in_room" });

    const parsed = SeatClaimEventSchema.safeParse(raw);
    if (!parsed.success) return ack?.({ error: "invalid_payload" });

    const result = roomManager.claimSeat(roomId, user.userId, parsed.data.seatId);
    if (!result) return ack?.({ error: "room_not_found" });
    if (!result.accepted) return ack?.({ error: result.reason });
    ack?.({ ok: true });
  });

  socket.on(ClientEvents.SeatRelease, (raw, ack?: (res: unknown) => void) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return ack?.({ error: "not_in_room" });

    // Payload is always {} — parsed only to reject malformed non-object
    // input consistently with every other handler here.
    if (!SeatReleaseEventSchema.safeParse(raw).success) return ack?.({ error: "invalid_payload" });

    roomManager.releaseSeat(roomId, user.userId);
    ack?.({ ok: true });
  });

  socket.on(ClientEvents.ObjectUpsert, async (raw, ack?: (res: unknown) => void) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return ack?.({ error: "not_in_room" });

    const parsed = ObjectUpsertEventSchema.safeParse(raw);
    if (!parsed.success) return ack?.({ error: "invalid_payload" });

    // Room membership/auth was already proven at join_room; object handlers
    // derive the room from socket.data.roomId (never the payload's roomId)
    // for the same reason the move handler does — a client cannot address
    // another room by simply putting a different id in the payload.
    await roomManager.hydrateObjects(roomId);

    const result = roomManager.applyObjectUpsert(roomId, user.userId, {
      objectId: parsed.data.objectId,
      roomId,
      type: parsed.data.type,
      x: parsed.data.x,
      y: parsed.data.y,
      width: parsed.data.width,
      height: parsed.data.height,
      rotation: parsed.data.rotation,
      z: parsed.data.z,
      data: parsed.data.data,
      baseVersion: parsed.data.baseVersion,
    });

    if (!result) return ack?.({ error: "room_not_found" });

    if (result.accepted) {
      io.to(roomId).emit(ServerEvents.ObjectSync, { object: result.next, accepted: true });
      return ack?.({ ok: true });
    }

    if (result.reason === "not_found") {
      // The object was deleted by someone else since this client last saw
      // it — nothing to sync it TO (ObjectSyncEventSchema requires a
      // non-null object), so just tell the writer it's gone.
      socket.emit(ServerEvents.ObjectRemoved, { objectId: parsed.data.objectId, roomId });
      return ack?.({ error: "not_found" });
    }

    // "room_full" | "id_collision" | "stale_version" — the first has no
    // authoritative object to send (nothing was ever created), the other
    // two do.
    if (result.authoritative) {
      socket.emit(ServerEvents.ObjectSync, { object: result.authoritative, accepted: false });
    }
    ack?.({ error: result.reason });
  });

  socket.on(ClientEvents.ObjectDelete, async (raw, ack?: (res: unknown) => void) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return ack?.({ error: "not_in_room" });

    const parsed = ObjectDeleteEventSchema.safeParse(raw);
    if (!parsed.success) return ack?.({ error: "invalid_payload" });

    await roomManager.hydrateObjects(roomId);

    const outcome = roomManager.applyObjectDelete(roomId, user.userId, parsed.data.objectId, parsed.data.baseVersion);
    if (!outcome) return ack?.({ error: "room_not_found" });

    if (outcome.outcome === "deleted" || outcome.outcome === "already_gone") {
      io.to(roomId).emit(ServerEvents.ObjectRemoved, { objectId: parsed.data.objectId, roomId });
      return ack?.({ ok: true });
    }

    // rejected: "stale_version" | "not_creator" — authoritative is always
    // present here since the object must exist for either rejection reason.
    socket.emit(ServerEvents.ObjectSync, { object: outcome.authoritative, accepted: false });
    ack?.({ error: outcome.reason });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId as string | undefined;
    // Fire-and-forget: removePeer is async since it may flush pending object
    // writes on eviction, but a disconnecting socket has nothing left to
    // wait on the result for. A crash between now and flush completion can
    // still lose at most one debounce window of edits — the same documented
    // limitation as the debounce itself (see objectPersistence.ts).
    if (roomId) void roomManager.removePeer(roomId, user.userId);
  });
});

startHeartbeat();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Clears every room's tick/lease-refresh interval and flushes any
    // pending object writes before exiting — awaited so a debounce window
    // in progress at shutdown doesn't silently lose edits.
    await roomManager.disposeAll();
    await stopHeartbeat();
    await app.close();
    process.exit(0);
  });
}

app.log.info(`realtime instance ${instanceId} listening on :${env.port}`);
