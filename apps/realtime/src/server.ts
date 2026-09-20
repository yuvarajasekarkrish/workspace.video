import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { resolveRoomEndpoint } from "@workspace-video/realtime-core";
import { loadRoomObjects, upsertObject, deleteObject, planParticipantLimitProvider, transientRetryStats } from "@workspace-video/db";
import type { ParticipantLimitProvider } from "@workspace-video/shared";
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
import { RoomManager, broadcasterFromSocketServer, type TickDiagnostics } from "./roomManager";
import { CountingBroadcaster } from "./countingBroadcaster";
import { EmitTailRecorder } from "./emitTailRecorder";
import { GcRecorder, startGcObserver } from "./gcRecorder";
import { maybeRegisterLoadHarnessRoutes } from "./loadHarnessRoutes";
import { provisionLoadHarnessWorkspace, teardownLoadHarnessWorkspace } from "./loadHarnessFixtures";
import { registerSocketHandlers } from "./socketHandlers";
import { registerInternalGuard, registerResolveRoomRoute } from "./internalRoutes";

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

// Production rules for /internal (see internalRoutes.ts). Registered before any
// route, because a Fastify hook only applies to routes added after it.
const production = process.env.NODE_ENV === "production";
registerInternalGuard(app, { production, metricsToken: env.internalMetricsToken });

app.get("/health", async () => ({ ok: true, instanceId }));

// Dev/testing convenience: exercises the exact same resolveRoomEndpoint path
// the Next.js `GET /api/rooms/:id/endpoint` handler will call in apps/web.
// Picks uniformly at random among currently live instances as the candidate.
// Not registered in production (the web app resolves rooms directly).
registerResolveRoomRoute(app, {
  production,
  resolve: (roomId) =>
    resolveRoomEndpoint(roomId, roomLease, instanceRegistry, async () => {
      const ids = await instanceRegistry.listActiveIds();
      if (ids.length === 0) return null;
      return ids[Math.floor(Math.random() * ids.length)]!;
    }),
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

// Phase 17 diagnostics (read-only): where does the event-loop delay come from.
// The emit-tail recorder and the GC recorder stamp everything on the
// performance.now() clock. A second loop-delay histogram, read and reset at
// every tick, was tried and removed: resetting drops the sample that spans the
// tick, so it could not see the tick's own blocking. The tick now measures the
// poll-phase work that follows it directly (RoomManager's postTickMs).
const emitTail = new EmitTailRecorder();
const gcRecorder = new GcRecorder();
const stopGcObserver = startGcObserver(gcRecorder);
const tickDiagnostics: TickDiagnostics = {
  beginTick: () => emitTail.beginTick(),
  endTick: () => emitTail.endTick(),
};

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

/** Phase 12: cumulative counts of every socket disconnect this instance has
 *  seen, by Socket.IO's own reason string — see the "disconnect" handler
 *  below for what each reason actually means. Exposed read-only via
 *  /internal/metrics; nothing resets it, same treatment as roomManager's
 *  lease-outcome counts. */
const disconnectReasonCounts: Record<string, number> = {};

/** Phase 14: the critical measurement for the mass-disconnect investigation
 *  — the actual Engine.IO heartbeat exchange, not just its eventual failure.
 *  Verified against the installed engine.io@6.6.10 (socket.js): the server
 *  sends "ping" via schedulePing()'s sendPacket("ping"), which emits
 *  "packetCreate" on socket.conn; the client's "pong" arrives through
 *  onPacket, which emits "packet" on socket.conn. Both are observable from
 *  outside engine.io without patching anything. Splits a heartbeat failure
 *  three ways: pingsSent with no matching pongsReceived means the pong never
 *  arrived (transport/client/path problem); pongsReceived close behind
 *  pingsSent with high maxPongLatencyMs means it arrived too late (a stall,
 *  not a loss); pingsSent itself failing to grow under load would mean the
 *  server never got to schedule the ping (a server-side scheduling problem)
 *  — see the Phase 14 plan.
 *
 *  Sampled across a fixed number of connections, not all of them — this is
 *  diagnostic instrumentation for a load test, not a production feature, and
 *  a handful of samples answers the mechanism question just as well as 100
 *  would while keeping the per-connection listener overhead negligible. */
const HEARTBEAT_SAMPLE_LIMIT = Number(process.env.HEARTBEAT_SAMPLE_LIMIT ?? "20");
let heartbeatSampledCount = 0;
const heartbeatStats = { pingsSent: 0, pongsReceived: 0, maxPongLatencyMs: 0 };

function maybeSampleHeartbeat(socket: { conn: { on(event: string, cb: (packet: { type?: string }) => void): void } }): void {
  if (heartbeatSampledCount >= HEARTBEAT_SAMPLE_LIMIT) return;
  heartbeatSampledCount++;

  let lastPingSentAt: number | null = null;
  socket.conn.on("packetCreate", (packet) => {
    if (packet.type !== "ping") return;
    lastPingSentAt = performance.now();
    heartbeatStats.pingsSent++;
  });
  socket.conn.on("packet", (packet) => {
    if (packet.type !== "pong" || lastPingSentAt === null) return;
    const latencyMs = performance.now() - lastPingSentAt;
    heartbeatStats.pongsReceived++;
    heartbeatStats.maxPongLatencyMs = Math.max(heartbeatStats.maxPongLatencyMs, latencyMs);
    lastPingSentAt = null;
  });
}

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
    staleDisconnectsIgnored: roomManager.getStaleDisconnectsIgnored(),
    proximityBatch: roomManager.getProximityBatchStats(),
    join: joinDuration.snapshot(),
    transientDbRetryAttempts: transientRetryStats.attempts,
    disconnectReasons: { ...disconnectReasonCounts },
    heartbeat: { ...heartbeatStats, sampledConnections: heartbeatSampledCount },
    moveValidation: roomManager.getMoveValidationStats(),
    emitTail: emitTail.snapshot(),
    gc: gcRecorder.snapshot(),
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

countingBroadcaster = new CountingBroadcaster(broadcasterFromSocketServer(io), 20, {
  tail: emitTail,
  // A socket id is also a room, so this covers both kinds of target.
  recipientsOf: (target) => io.sockets.adapter.rooms.get(target)?.size ?? 0,
});
roomManager = new RoomManager(
  countingBroadcaster,
  roomLease,
  instanceId,
  10_000,
  {
    loadRoomObjects,
    upsertObject,
    deleteObject,
  },
  tickDiagnostics,
  // Kill switch: PROXIMITY_BATCH=off makes the server ignore every client's
  // opt-in and send one proximity:update per change, as before batching.
  { proximityBatchEnabled: process.env.PROXIMITY_BATCH !== "off" },
);

registerSocketHandlers({
  io,
  roomManager,
  roomLease,
  authSecret: env.realtimeJwtSecret,
  instanceId,
  joinDuration,
  disconnectReasonCounts,
  loadHarnessLimitOverride,
  auth: { verifySessionToken, assertRoomMembership, assertWorkspaceMembership },
  onConnection: maybeSampleHeartbeat,
  emitTail,
});

startHeartbeat();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Clears every room's tick/lease-refresh interval and flushes any
    // pending object writes before exiting — awaited so a debounce window
    // in progress at shutdown doesn't silently lose edits.
    await roomManager.disposeAll();
    stopGcObserver();
    await stopHeartbeat();
    await app.close();
    process.exit(0);
  });
}

app.log.info(`realtime instance ${instanceId} listening on :${env.port}`);
