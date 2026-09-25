/**
 * Load harness for realtime scaling verification. Connects N Socket.IO
 * clients into one workspace, seats half by default (see LOAD_HARNESS_SEATED_FRACTION), walks the rest, and
 * measures the server over a steady-state window.
 *
 * Talks ONLY to the realtime server (REALTIME_URL): workspace/user/room
 * fixtures are created and removed through the server's dev-only
 * /internal/load-harness/* routes (start the server with
 * LOAD_HARNESS_ENABLED=1), so the load generator needs no database access
 * and can run on a separate machine. JWTs are minted locally with the shared
 * REALTIME_JWT_SECRET.
 *
 *   pnpm --filter @workspace-video/realtime run load-harness
 *
 * Env:
 *   REALTIME_URL                 default http://localhost:4001
 *   REALTIME_JWT_SECRET          must match the server
 *   LOAD_HARNESS_LABEL           tags the result file (default "local")
 *   LOAD_HARNESS_WINDOW_SEC      measurement window, default 8 (use 600 for validation)
 *   LOAD_HARNESS_ONLY_N          run a single N instead of 50/100/200
 *   LOAD_HARNESS_ONLY_SCENARIO   spread | cluster
 *   LOAD_HARNESS_INCLUDE_500=1   also run N=500 (server needs LOAD_HARNESS_LIMIT_OVERRIDE=500)
 *   LOAD_HARNESS_LAYOUT_ID       layout the throwaway room uses, e.g. office300@1 (default office300@1)
 *   LOAD_HARNESS_SEATED_FRACTION share of people who take a seat, 0 to 1 (default 0.5)
 *   LOAD_HARNESS_WALK_TO_SEAT    1 = walk each person to their seat before sitting (the server refuses a
 *                                seat unless they are within 120 px). Default off, as in every earlier run.
 *                                The report always prints how many seat claims the server accepted.
 *   LOAD_HARNESS_PROXIMITY_BATCH  default off. 1 = every client declares proximityBatch in join_room and
 *                                 receives proximity:batch (one frame per tick) instead of one
 *                                 proximity:update per change. The report prints frames AND updates
 *                                 received, and checks updates received against what the server sent.
 *   LOAD_HARNESS_RECONNECT_COUNT  default 0. That many walkers re-join on a NEW socket a third of
 *                                the way through the window and only then drop the old one — the
 *                                order a browser reconnect produces. Checks the room still
 *                                holds every user afterwards and that the server ignored the
 *                                stale disconnects. Everything else stays reconnection: false.
 *
 * During the window /internal/metrics is polled every 10s; CPU and
 * event-loop values are "since last read" deltas, tick percentiles cover the
 * last ~200 ticks. Gates use the WORST interval. Results go to
 * apps/realtime/load-results/<label>-<N>-<scenario>.json, and the process
 * exits with code 3 when the gate fails.
 *
 * Walkers start from their server-assigned spawn and step from real elapsed
 * time within the real 1760px floor, so move:correction reflects server
 * behaviour rather than harness artifacts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { monitorEventLoopDelay } from "node:perf_hooks";
import jwt from "jsonwebtoken";
import { io as ioClient, type Socket } from "socket.io-client";
import {
  ServerEvents,
  DEV_REALTIME_JWT_SECRET,
  type Point,
} from "@workspace-video/shared";
import type { EmitTailSnapshot } from "../emitTailRecorder";
import type { GcSnapshot } from "../gcRecorder";
import { formatStallReport } from "../stallReport";
import { checkProximityDelivery } from "../proximityDelivery";
import { parseHarnessOptions, seatTargetCount } from "../loadHarnessOptions";
import { stepToward, summarizeSeatAcks } from "../loadHarnessSeating";

const {
  layout: LAYOUT,
  movement: ROOM_MOVEMENT_CONFIG,
  seatedFraction: SEATED_FRACTION,
  walkToSeat: WALK_TO_SEAT,
} = parseHarnessOptions(process.env);
// Walking to a seat stays under the server's speed limit (2000 px/s) and is not part of the measured window.
const SEAT_WALK_SPEED_PX_PER_SEC = 1500;
const SEAT_WALK_TIMEOUT_MS = 20_000;
const SEAT_CLAIM_TIMEOUT_MS = 10_000;

const REALTIME_URL = process.env.REALTIME_URL ?? "http://localhost:4001";
const METRICS_URL = `${REALTIME_URL}/internal/metrics`;
const REALTIME_JWT_SECRET = process.env.REALTIME_JWT_SECRET ?? DEV_REALTIME_JWT_SECRET;
const WINDOW_MS = Math.max(1, Number(process.env.LOAD_HARNESS_WINDOW_SEC ?? "8")) * 1000;
const POLL_INTERVAL_MS = 10_000;
const MOVE_INTERVAL_MS = 50;
// Displacement is sized from real elapsed time so a late timer never implies
// a teleport; 400px/s is well under maxSpeedPxPerSec.
const WANDER_SPEED_PX_PER_SEC = 400;
const LABEL = process.env.LOAD_HARNESS_LABEL ?? "local";
// Phase 12: a handful of sockets that join but never claim a seat or send a
// move — see the Phase 12 plan's "idle canary" diagnostic. If these die in
// the same instant as the busy sockets, the cut is time-based, not induced
// by the traffic the busy sockets generate.
const IDLE_CANARY_COUNT = Math.max(0, Number(process.env.LOAD_HARNESS_IDLE_CANARIES ?? "3"));
const RECONNECT_COUNT = Math.max(0, Number(process.env.LOAD_HARNESS_RECONNECT_COUNT ?? "0"));
const PROXIMITY_BATCH = process.env.LOAD_HARNESS_PROXIMITY_BATCH === "1";
const RESULTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "load-results");

const GATE = {
  tickP95Ms: 25,
  tickP99Ms: 50,
  eventLoopP99Ms: 50,
  correctionRatePct: 0.1,
  rssGrowthPct: 15,
  rssGrowthMb: 30,
};

type Scenario = "spread" | "cluster";

interface PhaseTimingStats {
  avgMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
}

interface Metrics {
  instanceId: string;
  memoryUsage: NodeJS.MemoryUsage;
  tick: {
    sampleCount: number;
    avgMs: number;
    maxMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    avgPairChecks: number;
    avgEmits: number;
    phases: {
      positions: PhaseTimingStats;
      proximity: PhaseTimingStats;
      zone: PhaseTimingStats;
      audioEmit: PhaseTimingStats;
    };
  };
  cpuPercent: { user: number; system: number };
  eventLoop: { p50Ms: number; p99Ms: number; maxMs: number };
  emitRates: Record<string, { emitsPerSec: number; avgBytesPerEmit: number; bytesPerSecEstimate: number }>;
  redisPublishesPerSec: number;
  lease?: { renewed: number; reclaimed: number; lost: number; errors: number };
  join?: { sampleCount: number; avgMs: number; p50Ms: number; p95Ms: number; p99Ms: number };
  transientDbRetryAttempts?: number;
  disconnectReasons?: Record<string, number>;
  heartbeat?: { pingsSent: number; pongsReceived: number; maxPongLatencyMs: number; sampledConnections: number };
  moveValidation?: { accepted: MoveValidationSample[]; rejected: MoveValidationSample[]; windows?: TickWindowSample[] };
  staleDisconnectsIgnored?: number;
  /** Cumulative since server start; the harness uses window deltas. */
  proximityBatch?: { updatesTotal: number; batchedUpdatesTotal: number; batchFramesTotal: number; legacyFramesTotal: number };
  /** Phase 17 diagnostics. */
  emitTail?: EmitTailSnapshot;
  gc?: GcSnapshot;
}

/** Mirrors the server's TickWindowSample (apps/realtime/src/roomManager.ts). */
interface TickWindowSample {
  atMs: number;
  windowMs: number;
  elu: number;
  cpuWallRatio: number;
  tickMs: number;
  maxClusterUsers: number;
  emitCount: number;
  emitMs: number;
  postTickMs: number | null;
}

/** Mirrors the server's MoveValidationSample (apps/realtime/src/roomManager.ts)
 *  — duplicated because this script talks to the server only over HTTP. */
interface MoveValidationSample {
  elapsedMs: number;
  distancePx: number;
  impliedSpeedPxPerSec: number;
  serverGapMs: number | null;
  clientGapMs: number | null;
  atMs: number;
  userId: string;
}

const medianOrNull = (values: number[]): number | null => (values.length === 0 ? null : median(values));

/** Numbers only, deliberately no verdict text: this feeds the Phase 15
 *  question of WHY rejected moves arrive with ~0 elapsed, and an automatic
 *  "this proves X" line is exactly what the plan warns against. The reading
 *  guide lives in the Phase 15 plan, next to the evidence it needs.
 *
 *  Clustering: rejections are bucketed by server receipt time (10ms). If
 *  rejections from DIFFERENT users land in the same bucket more often than
 *  chance, something shared hit them together; if not, it looks
 *  per-connection. "Expected by chance" places the same number of
 *  rejections uniformly at random over the same time span, so the observed
 *  figure has something to be compared against. */
function summarizeRejections(rejected: MoveValidationSample[]): {
  serverGapMedianMs: number | null;
  clientGapMedianMs: number | null;
  samplesWithGaps: number;
  clustering: { bucketMs: number; spanMs: number; observedSharedSamples: number; expectedSharedByChance: number; largestBucketDistinctUsers: number };
} {
  const BUCKET_MS = 10;
  const withGaps = rejected.filter((s) => s.serverGapMs !== null && s.clientGapMs !== null);
  const buckets = new Map<number, Set<string>>();
  const perBucketCount = new Map<number, number>();
  for (const s of rejected) {
    const key = Math.floor(s.atMs / BUCKET_MS);
    if (!buckets.has(key)) buckets.set(key, new Set());
    buckets.get(key)!.add(s.userId);
    perBucketCount.set(key, (perBucketCount.get(key) ?? 0) + 1);
  }
  let observedShared = 0;
  let largest = 0;
  for (const [key, users] of buckets) {
    largest = Math.max(largest, users.size);
    if (users.size >= 2) observedShared += perBucketCount.get(key)!;
  }
  const times = rejected.map((s) => s.atMs);
  const spanMs = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;
  const bucketCount = Math.max(1, Math.floor(spanMs / BUCKET_MS));
  const n = rejected.length;
  const expectedShared = n <= 1 ? 0 : n * (1 - Math.pow(1 - 1 / bucketCount, n - 1));
  return {
    serverGapMedianMs: medianOrNull(withGaps.map((s) => s.serverGapMs!)),
    clientGapMedianMs: medianOrNull(withGaps.map((s) => s.clientGapMs!)),
    samplesWithGaps: withGaps.length,
    clustering: {
      bucketMs: BUCKET_MS,
      spanMs,
      observedSharedSamples: observedShared,
      expectedSharedByChance: expectedShared,
      largestBucketDistinctUsers: largest,
    },
  };
}

interface IntervalSample {
  atSec: number;
  durationSec: number;
  cpuPctOfOneCore: number;
  tickP50Ms: number;
  tickP95Ms: number;
  tickP99Ms: number;
  tickMaxMs: number;
  eventLoopP99Ms: number;
  eventLoopMaxMs: number;
  rssMb: number;
  phaseAvgMs: { positions: number; proximity: number; zone: number; audioEmit: number };
  avgPairChecks: number;
  avgEmits: number;
  serverEmitBytesPerSec: number;
  redisPublishesPerSec: number;
  /** Phase 10c diagnostic fields — null when that poll's fetch failed. */
  occupancyActive: number | null;
  occupancyLimit: number | null;
  /** Phase 13: the LOAD GENERATOR's own event-loop delay for this interval —
   *  same "since last read" histogram-reset contract as server.ts's
   *  eventLoop fields, but measuring this 2-core box driving 100 sockets,
   *  not the server. Only the server's event loop was ever measured before;
   *  this is what separates "the harness box is starving its own Socket.IO
   *  heartbeats" from "the tunnel can't carry this traffic" when sockets
   *  drop with ping timeout but the SERVER's own event loop is healthy. */
  harnessEventLoopP50Ms: number;
  harnessEventLoopP99Ms: number;
  harnessEventLoopMaxMs: number;
}

async function fetchMetrics(): Promise<Metrics | null> {
  try {
    const res = await fetch(METRICS_URL);
    if (!res.ok) return null;
    return (await res.json()) as Metrics;
  } catch {
    return null;
  }
}

interface OccupancySnapshot {
  active: number;
  limit: number;
}

/** Phase 10c diagnostic: the server's own idea of "how many are really
 *  here" for this specific room, polled alongside /internal/metrics — see
 *  loadHarnessRoutes.ts's /internal/load-harness/occupancy/:roomId. Best
 *  effort: a failure here doesn't fail the poll, it just leaves this
 *  interval's occupancy fields null (itself diagnostic — see
 *  metricsPollOk below for the equivalent on the metrics side). */
async function fetchOccupancy(roomId: string): Promise<OccupancySnapshot | null> {
  try {
    const res = await fetch(`${REALTIME_URL}/internal/load-harness/occupancy/${roomId}`);
    if (!res.ok) return null;
    return (await res.json()) as OccupancySnapshot;
  } catch {
    return null;
  }
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${REALTIME_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 404) {
    throw new Error(`${path} returned 404: start the realtime server with LOAD_HARNESS_ENABLED=1 (and NODE_ENV not production).`);
  }
  if (!res.ok) throw new Error(`${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

type Workspace = { workspaceId: string; roomId: string; users: { id: string; email: string }[] };

function provisionWorkspace(n: number): Promise<Workspace> {
  return postJson<Workspace>("/internal/load-harness/provision", { n, layoutId: LAYOUT.id });
}

async function teardownWorkspace(workspaceId: string, userIds: string[]): Promise<void> {
  await postJson("/internal/load-harness/teardown", { workspaceId, userIds }).catch((err) =>
    console.error("  teardown failed:", (err as Error).message),
  );
}

/** Walks a joined socket to `target` in steps the server's speed limit accepts, so a seat claim
 *  from there is inside the server's 120 px range. Ends at the target or after the time limit. */
/** Walk-phase-only diagnostic (see the seat-claim shortfall investigation):
 *  whether the LOCAL step loop believed it reached the seat's exact anchor
 *  before the timeout, the client-side distance still remaining if not, and
 *  how many moves this walk actually sent. This describes what the harness
 *  ASKED the server for — it does not by itself prove what the server's
 *  authoritative position ended up at; that's cross-checked against the
 *  seat:claim ack's own error string and this walker's move:correction count
 *  by the caller. */
interface WalkResult {
  converged: boolean;
  finalDistancePx: number;
  movesSent: number;
  /** How many times this walk reconciled to a server-pushed move:correction
   *  before computing its next step — see walkTo's docs. Non-zero here means
   *  at least one move in this walk was rejected; zero means the walk never
   *  needed to resync at all. */
  correctionsReconciled: number;
}

async function walkTo(c: ConnectedSocket, target: Point): Promise<WalkResult> {
  let position = c.spawnPosition;
  const stepPx = (SEAT_WALK_SPEED_PX_PER_SEC * MOVE_INTERVAL_MS) / 1000;
  const deadline = performance.now() + SEAT_WALK_TIMEOUT_MS;
  let movesSent = 0;
  let correctionsReconciled = 0;
  while ((position.x !== target.x || position.y !== target.y) && performance.now() < deadline) {
    // Reconcile to the server's authoritative position before computing the
    // next step — the same thing a real browser client already does on every
    // move:correction (see PixiStage.ts's onMoveCorrection). Without this, a
    // single rejected move (which the movement-validation fix no longer lets
    // become PERMANENT, but which can still happen once) would leave this
    // walker computing every future step from a position the server never
    // accepted, re-diverging on its own.
    if (c.pendingCorrection) {
      position = c.pendingCorrection;
      c.pendingCorrection = null;
      correctionsReconciled++;
    }
    position = stepToward(position, target, stepPx);
    c.socket.emit("move", { position, clientTs: Date.now() });
    movesSent++;
    await new Promise<void>((resolve) => setTimeout(resolve, MOVE_INTERVAL_MS));
  }
  // One last check after the loop's final sleep, so a correction to the very
  // last emitted move isn't missed by the convergence check below.
  if (c.pendingCorrection) {
    position = c.pendingCorrection;
    c.pendingCorrection = null;
    correctionsReconciled++;
  }
  const converged = position.x === target.x && position.y === target.y;
  const finalDistancePx = Math.hypot(target.x - position.x, target.y - position.y);
  return { converged, finalDistancePx, movesSent, correctionsReconciled };
}

function mintToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, REALTIME_JWT_SECRET, { expiresIn: "1h" });
}

interface ConnectedSocket {
  socket: Socket;
  userId: string;
  spawnPosition: Point;
  eventCounts: Record<string, number>;
  /** Proximity updates received in the window, counted per update whichever
   *  format carried them (one per proximity:update, N per proximity:batch). */
  proximityUpdatesReceived: number;
  corrections: number;
  bytesReceived: number;
  /** Phase 10c diagnostic: null while connected. Set the moment this socket
   *  disconnects for ANY reason after joining — reconnection is disabled
   *  (see connectSocket), so this is permanent once set. Absolute
   *  performance.now() timestamp; converted to "seconds into the
   *  measurement window" when the report is built, since a disconnect can
   *  happen during setup too. */
  disconnectedAtMs: number | null;
  disconnectReason: string | null;
  /** Phase 11 Part C: set the moment this socket receives owner:changed —
   *  the server's own signal that it evicted this room (see roomManager.ts's
   *  evictRoom). Had this existed during Phase 10c's N=100 run, the run
   *  would have named its own cause (a lease eviction) instead of the
   *  investigation needing three rounds of instrumentation to find it. */
  ownerChangedAtMs: number | null;
  /** Phase 12: timestamp of the most recently received engine.io "ping"
   *  packet (the server->client heartbeat). Used to compute the gap between
   *  the last ping this socket actually saw and its eventual disconnect —
   *  if that gap is small (pings were flowing normally right up to the
   *  drop), a ping-timeout explanation is dead regardless of what the
   *  disconnect reason string says. */
  lastPingAtMs: number | null;
  /** Phase 12: true for a small set of sockets that join but never send a
   *  `move` — see IDLE_CANARY_COUNT. If these die in the same instant as
   *  the busy sockets, the cause is time-based, not traffic-induced. */
  isIdleCanary: boolean;
  /** Set after a reconnect re-join: the server resets a re-joined peer to its
   *  spawn point, so the walker must restart from there or its first move
   *  would be a teleport the server rightly rejects. */
  resyncTo: Point | null;
  /** The server's authoritative position from the most recent unconsumed
   *  move:correction, or null once reconciled. Mirrors what a real browser
   *  client already does (apps/web/src/canvas/PixiStage.ts's onMoveCorrection
   *  -> MovementController.applyCorrection) — walkTo consumes this before
   *  computing its next step so a rejected move (see the movement-validation
   *  race fix in packages/proximity/src/movement.ts) doesn't leave this
   *  synthetic walker's belief permanently diverged from the server's real
   *  position, the way it did before this field existed. */
  pendingCorrection: Point | null;
}

function connectSocket(
  token: string,
  userId: string,
  roomId: string,
): Promise<{ socket: Socket; joinLatencyMs: number; ack: unknown; spawnPosition: Point | null }> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(REALTIME_URL, { auth: { token }, reconnection: false, timeout: 10_000 });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`connect timeout for ${userId}`));
    }, 15_000);
    let spawnPosition: Point | null = null;

    socket.on("peers:snapshot", (payload: { peers?: { userId: string; position: Point }[] }) => {
      const self = payload.peers?.find((p) => p.userId === userId);
      if (self) spawnPosition = self.position;
    });

    socket.on("connect", () => {
      const start = performance.now();
      socket.emit("join_room", { roomId, ...(PROXIMITY_BATCH ? { proximityBatch: true } : {}) }, (ack: unknown) => {
        clearTimeout(timer);
        resolve({ socket, joinLatencyMs: performance.now() - start, ack, spawnPosition });
      });
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(err);
    });
  });
}

const correctionReasons: Record<string, number> = {};

function attachCounters(entry: ConnectedSocket): void {
  for (const event of ["peers:delta", "proximity:update", "proximity:batch", "occupancy:update", "seat:update", "zone:changed"]) {
    entry.socket.on(event, (payload: { updates?: unknown[] }) => {
      entry.eventCounts[event] = (entry.eventCounts[event] ?? 0) + 1;
      if (event === "proximity:update") entry.proximityUpdatesReceived += 1;
      if (event === "proximity:batch") entry.proximityUpdatesReceived += payload?.updates?.length ?? 0;
    });
  }
  entry.socket.on("move:correction", (payload: { reason?: string; position?: Point }) => {
    const reason = payload.reason ?? "unknown";
    correctionReasons[reason] = (correctionReasons[reason] ?? 0) + 1;
    entry.corrections++;
    if (payload.position) entry.pendingCorrection = payload.position;
  });

  // Phase 10c diagnostic: with reconnection disabled, this fires exactly
  // once, permanently, the moment a socket the harness still thinks is
  // "connected" actually drops — the gap the N=200 anomaly investigation
  // needs visibility into (see loadHarness.ts's file header and the Phase
  // 10c plan). Never previously tracked, so a mid-run drop was invisible.
  entry.socket.on("disconnect", (reason: string) => {
    if (entry.disconnectedAtMs === null) {
      entry.disconnectedAtMs = performance.now();
      entry.disconnectReason = reason;
    }
  });

  // Phase 11 Part C: the server's own admission that it evicted this room
  // (roomManager.ts's evictRoom, fired only on a genuine "lost" lease
  // outcome — see Part A). Recorded separately from the disconnect above
  // because owner:changed always arrives BEFORE the disconnect it causes,
  // so this is what tells us WHY a socket dropped, not just that it did.
  entry.socket.on(ServerEvents.OwnerChanged, () => {
    if (entry.ownerChangedAtMs === null) {
      entry.ownerChangedAtMs = performance.now();
    }
  });

  const engine = (entry.socket.io as unknown as { engine?: { on(event: string, cb: (packet: { type?: string; data?: unknown }) => void): void } }).engine;
  engine?.on("packet", (packet) => {
    if (typeof packet.data === "string") entry.bytesReceived += packet.data.length;
    else if (packet.data && typeof (packet.data as { length?: number }).length === "number") {
      entry.bytesReceived += (packet.data as { length: number }).length;
    }
    // Phase 12: engine.io's own heartbeat packet, distinct from any
    // application-level event above — see lastPingAtMs's docs.
    if (packet.type === "ping") entry.lastPingAtMs = performance.now();
  });
}

function randomStep(elapsedSec: number): { dx: number; dy: number } {
  const angle = Math.random() * Math.PI * 2;
  const distance = WANDER_SPEED_PX_PER_SEC * elapsedSec;
  return { dx: Math.cos(angle) * distance, dy: Math.sin(angle) * distance };
}

function clampToFloor(value: number, max: number): number {
  return Math.min(Math.max(value, 0), max);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;
}

function summarizeLatencies(values: number[]): { avg: number; p95: number; max: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
  return { avg: average(values), p95, max: sorted[sorted.length - 1]! };
}

function toIntervalSample(
  m: Metrics,
  occ: OccupancySnapshot | null,
  atSec: number,
  durationSec: number,
  harnessEventLoop: { p50Ms: number; p99Ms: number; maxMs: number },
): IntervalSample {
  return {
    atSec,
    durationSec,
    cpuPctOfOneCore: m.cpuPercent.user + m.cpuPercent.system,
    tickP50Ms: m.tick.p50Ms,
    tickP95Ms: m.tick.p95Ms,
    tickP99Ms: m.tick.p99Ms,
    tickMaxMs: m.tick.maxMs,
    eventLoopP99Ms: m.eventLoop.p99Ms,
    eventLoopMaxMs: m.eventLoop.maxMs,
    rssMb: m.memoryUsage.rss / 1024 / 1024,
    phaseAvgMs: {
      positions: m.tick.phases.positions.avgMs,
      proximity: m.tick.phases.proximity.avgMs,
      zone: m.tick.phases.zone.avgMs,
      audioEmit: m.tick.phases.audioEmit.avgMs,
    },
    avgPairChecks: m.tick.avgPairChecks,
    avgEmits: m.tick.avgEmits,
    serverEmitBytesPerSec: Object.values(m.emitRates).reduce((sum, r) => sum + r.bytesPerSecEstimate, 0),
    redisPublishesPerSec: m.redisPublishesPerSec,
    occupancyActive: occ?.active ?? null,
    occupancyLimit: occ?.limit ?? null,
    harnessEventLoopP50Ms: harnessEventLoop.p50Ms,
    harnessEventLoopP99Ms: harnessEventLoop.p99Ms,
    harnessEventLoopMaxMs: harnessEventLoop.maxMs,
  };
}

/** Polls /internal/metrics (+ this room's occupancy — Phase 10c diagnostic)
 *  every POLL_INTERVAL_MS until stop() is called. A self-scheduling
 *  setTimeout chain (never overlapping polls) that stops itself, rather
 *  than a free-running interval. Tracks poll attempts vs successes
 *  separately from the samples array, since a fully-failed poll produces
 *  no sample at all but is itself diagnostic (see the Phase 10c plan's
 *  "log poll failures explicitly" item — N=100's run silently got half the
 *  expected polls). */
function startMetricsPoller(
  windowStartAt: number,
  roomId: string,
): { stop(): Promise<{ samples: IntervalSample[]; pollAttempts: number; metricsPollFailures: number }> } {
  const samples: IntervalSample[] = [];
  let pollAttempts = 0;
  let metricsPollFailures = 0;
  let lastAt = windowStartAt;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  // Phase 13: this box's own event-loop delay, same resolution and
  // reset-on-read contract as server.ts's histogram — see harnessEventLoop*
  // fields' docs on IntervalSample.
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 });
  eventLoopDelay.enable();

  const poll = async () => {
    pollAttempts++;
    const [m, occ] = await Promise.all([fetchMetrics(), fetchOccupancy(roomId)]);
    const now = performance.now();
    const harnessEventLoop = {
      p50Ms: eventLoopDelay.percentile(50) / 1e6,
      p99Ms: eventLoopDelay.percentile(99) / 1e6,
      maxMs: eventLoopDelay.max / 1e6,
    };
    eventLoopDelay.reset();
    if (m) {
      samples.push(toIntervalSample(m, occ, (now - windowStartAt) / 1000, (now - lastAt) / 1000, harnessEventLoop));
    } else {
      metricsPollFailures++;
    }
    lastAt = now;
  };

  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      inFlight = poll().finally(() => {
        if (!stopped) schedule();
      });
    }, POLL_INTERVAL_MS);
  };
  schedule();

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
      await poll(); // final partial interval up to the end of the window
      eventLoopDelay.disable(); // must not outlive the run
      return { samples, pollAttempts, metricsPollFailures };
    },
  };
}

function rssStability(samples: IntervalSample[]): { stable: boolean | null; firstThirdMb: number; lastThirdMb: number } {
  const postWarmup = samples.slice(Math.min(2, Math.max(0, samples.length - 3)));
  if (postWarmup.length < 3) return { stable: null, firstThirdMb: 0, lastThirdMb: 0 };
  const third = Math.max(1, Math.floor(postWarmup.length / 3));
  const firstThirdMb = average(postWarmup.slice(0, third).map((s) => s.rssMb));
  const lastThirdMb = average(postWarmup.slice(-third).map((s) => s.rssMb));
  const growthMb = lastThirdMb - firstThirdMb;
  const stable = growthMb <= GATE.rssGrowthMb || lastThirdMb <= firstThirdMb * (1 + GATE.rssGrowthPct / 100);
  return { stable, firstThirdMb, lastThirdMb };
}

function writeResultJson(n: number, scenario: Scenario, result: Record<string, unknown>): void {
  try {
    mkdirSync(RESULTS_DIR, { recursive: true });
    const path = join(RESULTS_DIR, `${LABEL}-${n}-${scenario}.json`);
    writeFileSync(path, JSON.stringify(result, null, 2));
    console.log(`  results written to ${path}`);
  } catch (err) {
    console.error("  failed to write load-results JSON:", err);
  }
}

const fmt = (v: number, digits = 2) => v.toFixed(digits);

/** Runs one phase and returns whether its gate passed. */
async function runPhase(n: number, scenario: Scenario, limitOverrideNote?: string): Promise<boolean> {
  console.log(
    `\n=== N=${n}, scenario=${scenario}, window=${WINDOW_MS / 1000}s${limitOverrideNote ? ` (${limitOverrideNote})` : ""} ===`,
  );
  const { workspaceId, roomId, users } = await provisionWorkspace(n);
  const connected: ConnectedSocket[] = [];
  const joinLatencies: number[] = [];
  let rejectedCount = 0;
  let joinFailures = 0;
  // Phase 15 Part A: previously discarded — a rejected join told us nothing
  // beyond "it was rejected," so a spurious workspace_full couldn't be told
  // apart from a real one. Sampled to a handful of entries; the count above
  // already carries the volume.
  const rejectionSamples: unknown[] = [];
  let passed = false;

  try {
    const BATCH_SIZE = 10;
    for (let i = 0; i < n; i += BATCH_SIZE) {
      const batch = users.slice(i, Math.min(i + BATCH_SIZE, n));
      const results = await Promise.allSettled(batch.map((u) => connectSocket(mintToken(u.id, u.email), u.id, roomId)));
      results.forEach((result, idx) => {
        const user = batch[idx]!;
        if (result.status === "fulfilled") {
          const { socket, joinLatencyMs, ack, spawnPosition } = result.value;
          if ((ack as { ok?: boolean })?.ok) {
            joinLatencies.push(joinLatencyMs);
            const entry: ConnectedSocket = {
              socket,
              userId: user.id,
              spawnPosition: spawnPosition ?? { x: 0, y: 0 },
              eventCounts: {},
              proximityUpdatesReceived: 0,
              corrections: 0,
              bytesReceived: 0,
              disconnectedAtMs: null,
              disconnectReason: null,
              ownerChangedAtMs: null,
              lastPingAtMs: null,
              // The first IDLE_CANARY_COUNT successfully-joined sockets never
              // get a moveTimer below — see the walkers filter.
              isIdleCanary: connected.length < IDLE_CANARY_COUNT,
              resyncTo: null,
              pendingCorrection: null,
            };
            attachCounters(entry);
            connected.push(entry);
          } else {
            rejectedCount += 1;
            if (rejectionSamples.length < 5) rejectionSamples.push(ack);
            socket.disconnect();
          }
        } else {
          joinFailures += 1;
          console.error(`  join failed for ${user.email}:`, result.reason?.message ?? result.reason);
        }
      });
    }

    console.log(
      `  joined: ${connected.length}/${n} (rejected: ${rejectedCount}, failed: ${joinFailures})` +
        (rejectionSamples.length > 0 ? `  rejection reasons: ${JSON.stringify(rejectionSamples)}` : ""),
    );
    const joinLatency = joinLatencies.length > 0 ? summarizeLatencies(joinLatencies) : null;
    if (joinLatency) {
      console.log(`  join latency: avg ${fmt(joinLatency.avg, 1)}ms, p95 ${fmt(joinLatency.p95, 1)}ms, max ${fmt(joinLatency.max, 1)}ms`);
    }

    // Phase 12: idle canaries never claim a seat or move — see IDLE_CANARY_COUNT.
    const seatCandidates = connected.filter((c) => !c.isIdleCanary);
    const seatTargets = LAYOUT.seats.slice(0, seatTargetCount(n, seatCandidates.length, LAYOUT.seats.length, SEATED_FRACTION));
    const seatedSockets = new Set<ConnectedSocket>();
    const seatAcks: unknown[] = [];
    // Walk-phase diagnostic (seat-claim shortfall investigation): one record
    // per attempted seat, captured BEFORE the steady-state reset below zeroes
    // `corrections` — this is the only chance to see what happened during the
    // walk itself, which the reset below would otherwise erase without a trace.
    interface WalkPhaseRecord {
      userId: string;
      seatId: string;
      correctionsBeforeWalk: number;
      correctionsAfterWalk: number;
      walk: WalkResult | null;
      walkPhaseDurationMs: number;
      ackOk: boolean;
      ackReason: string | null;
    }
    const walkPhaseRecords: WalkPhaseRecord[] = [];
    const walkPhaseStartedAtMs = performance.now();
    await Promise.all(
      seatTargets.map(async (seat, i) => {
        const candidate = seatCandidates[i]!;
        seatedSockets.add(candidate);
        const correctionsBeforeWalk = candidate.corrections;
        const recordStartedAtMs = performance.now();
        const walk = WALK_TO_SEAT ? await walkTo(candidate, seat.anchor) : null;
        const correctionsAfterWalk = candidate.corrections;
        const ack: unknown = await new Promise((resolve) => {
          // A timeout counts as "no reply" rather than hanging the run.
          candidate.socket.timeout(SEAT_CLAIM_TIMEOUT_MS).emit("seat:claim", { seatId: seat.id }, (err: Error | null, res: unknown) => {
            resolve(err ? undefined : res);
          });
        });
        seatAcks.push(ack);
        const parsedAck = typeof ack === "object" && ack !== null ? (ack as { ok?: unknown; error?: unknown }) : {};
        walkPhaseRecords.push({
          userId: candidate.userId,
          seatId: seat.id,
          correctionsBeforeWalk,
          correctionsAfterWalk,
          walk,
          walkPhaseDurationMs: performance.now() - recordStartedAtMs,
          ackOk: parsedAck.ok === true,
          ackReason: typeof parsedAck.error === "string" ? parsedAck.error : parsedAck.ok === true ? null : "no_reply",
        });
      }),
    );
    const walkPhaseTotalDurationMs = performance.now() - walkPhaseStartedAtMs;
    const seatSummary = summarizeSeatAcks(seatAcks);
    console.log(
      `  seated: ${seatTargets.length} asked · server accepted ${seatSummary.accepted} · refused ${JSON.stringify(seatSummary.refused)}` +
        (WALK_TO_SEAT ? " (each walked to their seat first)" : " (NOT walked to the seat: claims sent from the arrival spot)"),
    );

    // Walk-phase breakdown — see WalkPhaseRecord's docs. Classifies every
    // failure into a proven bucket instead of assuming a cause.
    const failed = walkPhaseRecords.filter((r) => !r.ackOk);
    const failedWithWalkCorrection = failed.filter((r) => r.correctionsAfterWalk > r.correctionsBeforeWalk);
    const failedDidNotConverge = failed.filter((r) => r.walk !== null && !r.walk.converged);
    const failedConvergedButRefused = failed.filter(
      (r) => r.correctionsAfterWalk === r.correctionsBeforeWalk && (r.walk === null || r.walk.converged),
    );
    const totalWalkCorrections = walkPhaseRecords.reduce((sum, r) => sum + (r.correctionsAfterWalk - r.correctionsBeforeWalk), 0);
    const totalReconciled = walkPhaseRecords.reduce((sum, r) => sum + (r.walk?.correctionsReconciled ?? 0), 0);
    console.log(
      `  walk-phase (${fmt(walkPhaseTotalDurationMs, 0)}ms total, ${walkPhaseRecords.length} attempted):` +
        ` corrections during walk: ${totalWalkCorrections} (affecting ${walkPhaseRecords.filter((r) => r.correctionsAfterWalk > r.correctionsBeforeWalk).length} users)` +
        ` · reconciled to a server correction mid-walk: ${totalReconciled} time(s)` +
        ` · failures: ${failed.length}` +
        ` [rejected-move-implicated: ${failedWithWalkCorrection.length}, walk-did-not-converge: ${failedDidNotConverge.length}, converged-but-still-refused: ${failedConvergedButRefused.length}]`,
    );
    if (failedConvergedButRefused.length > 0) {
      console.log(
        `  UNEXPLAINED: ${failedConvergedButRefused.length} users walked to their exact target, sent no rejected/corrected move, yet the server still refused the claim — reasons: ${JSON.stringify(
          failedConvergedButRefused.reduce((acc: Record<string, number>, r) => {
            const key = r.ackReason ?? "no_reply";
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {}),
        )}`,
      );
    }
    const seatIdsClaimed = walkPhaseRecords.filter((r) => r.ackOk).map((r) => r.seatId);
    const duplicateSeatIds = seatIdsClaimed.filter((id, idx) => seatIdsClaimed.indexOf(id) !== idx);
    if (duplicateSeatIds.length > 0) {
      console.log(`  DOUBLE-BOOKING DETECTED: ${JSON.stringify(duplicateSeatIds)}`);
    } else {
      console.log(`  no double-booking: ${seatIdsClaimed.length} accepted claims, ${new Set(seatIdsClaimed).size} distinct seats`);
    }

    // Reset counters and the server's "since last read" deltas so everything
    // below describes only the steady-state window. Walk-phase data above was
    // already captured and printed before this point — nothing here erases it.
    for (const c of connected) {
      c.eventCounts = {};
      c.proximityUpdatesReceived = 0;
      c.corrections = 0;
      c.bytesReceived = 0;
    }
    for (const key of Object.keys(correctionReasons)) delete correctionReasons[key];
    const startMetrics = await fetchMetrics();
    const windowStartAt = performance.now();
    const poller = startMetricsPoller(windowStartAt, roomId);

    let movesSent = 0;
    const walkers = connected.filter((c) => !seatedSockets.has(c) && !c.isIdleCanary);
    const clusterCenter = walkers[0]?.spawnPosition ?? { x: ROOM_MOVEMENT_CONFIG.roomWidthPx / 2, y: ROOM_MOVEMENT_CONFIG.roomHeightPx / 2 };
    const moveTimers = walkers.map((c) => {
      let { x, y } = scenario === "cluster" ? clusterCenter : c.spawnPosition;
      let lastSentAt = performance.now();
      return setInterval(() => {
        if (c.resyncTo) {
          ({ x, y } = c.resyncTo);
          c.resyncTo = null;
        }
        const now = performance.now();
        const { dx, dy } = randomStep(Math.max(0, (now - lastSentAt) / 1000));
        lastSentAt = now;
        x = clampToFloor(x + dx, ROOM_MOVEMENT_CONFIG.roomWidthPx);
        y = clampToFloor(y + dy, ROOM_MOVEMENT_CONFIG.roomHeightPx);
        c.socket.emit("move", { position: { x, y }, clientTs: Date.now() });
        movesSent++;
      }, MOVE_INTERVAL_MS);
    });

    // Reconnect churn: a third of the way into the window, so there is steady
    // state on both sides of it. The new socket is joined BEFORE the old one
    // is dropped, which is the order that exposes a stale-disconnect bug.
    const churn = {
      requested: Math.min(RECONNECT_COUNT, walkers.length),
      performed: 0,
      failed: 0,
      occupancyAfter: null as number | null,
    };
    const churnPromise: Promise<void> =
      churn.requested > 0
        ? new Promise<void>((resolve) => {
            setTimeout(() => {
              void (async () => {
                for (const c of walkers.slice(0, churn.requested)) {
                  const user = users.find((u) => u.id === c.userId)!;
                  try {
                    const next = await connectSocket(mintToken(user.id, user.email), user.id, roomId);
                    if (!(next.ack as { ok?: boolean })?.ok) {
                      churn.failed++;
                      next.socket.disconnect();
                      continue;
                    }
                    const old = c.socket;
                    c.socket = next.socket;
                    c.resyncTo = next.spawnPosition ?? c.spawnPosition;
                    attachCounters(c);
                    // The drop below is deliberate, not a failure to report.
                    old.off("disconnect");
                    old.disconnect();
                    churn.performed++;
                  } catch (err) {
                    churn.failed++;
                    console.error(`  reconnect failed for ${user.email}:`, (err as Error).message);
                  }
                }
                // Let the server process the old sockets' disconnects.
                await new Promise((r) => setTimeout(r, 1500));
                churn.occupancyAfter = (await fetchOccupancy(roomId))?.active ?? null;
                resolve();
              })();
            }, WINDOW_MS / 3);
          })
        : Promise.resolve();

    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
    await churnPromise;
    moveTimers.forEach(clearInterval);
    const windowElapsedSec = (performance.now() - windowStartAt) / 1000;
    const { samples: intervals, pollAttempts, metricsPollFailures } = await poller.stop();
    // Phase 11/12: one last read for the server's own bookkeeping — lease
    // outcomes, server-side join latency, DB retry attempts, and disconnect
    // reasons — taken right after the window closes so it reflects this run,
    // not a future one. Best-effort: a failed fetch here doesn't fail the
    // run, it just leaves these fields absent from the report.
    const finalMetrics = await fetchMetrics();

    const totalEvents = connected.reduce((sum, c) => sum + Object.values(c.eventCounts).reduce((a, b) => a + b, 0), 0);
    const corrections = connected.reduce((sum, c) => sum + c.corrections, 0);
    const bytesReceived = connected.reduce((sum, c) => sum + c.bytesReceived, 0);
    // Proximity delivery, counted per UPDATE so batched and per-peer runs are
    // comparable: what clients received against what the server decided to send
    // in the same window. A validity check on the run, not a success metric.
    const clientProximityUpdates = connected.reduce((sum, c) => sum + c.proximityUpdatesReceived, 0);
    const clientProximityFrames = {
      batch: connected.reduce((sum, c) => sum + (c.eventCounts["proximity:batch"] ?? 0), 0),
      update: connected.reduce((sum, c) => sum + (c.eventCounts["proximity:update"] ?? 0), 0),
    };
    const serverProximity =
      startMetrics?.proximityBatch && finalMetrics?.proximityBatch
        ? {
            updates: finalMetrics.proximityBatch.updatesTotal - startMetrics.proximityBatch.updatesTotal,
            batchedUpdates: finalMetrics.proximityBatch.batchedUpdatesTotal - startMetrics.proximityBatch.batchedUpdatesTotal,
            batchFrames: finalMetrics.proximityBatch.batchFramesTotal - startMetrics.proximityBatch.batchFramesTotal,
            legacyFrames: finalMetrics.proximityBatch.legacyFramesTotal - startMetrics.proximityBatch.legacyFramesTotal,
          }
        : null;
    const proximityDelivery = serverProximity
      ? checkProximityDelivery({ serverUpdates: serverProximity.updates, clientUpdates: clientProximityUpdates })
      : null;
    const correctionRatePct = movesSent > 0 ? (corrections / movesSent) * 100 : 0;

    // Phase 10c diagnostic: how many of the sockets the harness still
    // believes are "connected" actually survived the whole window. Any
    // entry here disconnected for real — reconnection is disabled, so this
    // is not a reconnect-and-recover situation, it's permanent.
    const droppedSockets = connected
      .filter((c) => c.disconnectedAtMs !== null)
      .map((c) => ({
        userId: c.userId,
        disconnectedAtSec: (c.disconnectedAtMs! - windowStartAt) / 1000,
        reason: c.disconnectReason,
        // Phase 11 Part C: non-null here means the SERVER evicted the room
        // (see roomManager.ts's evictRoom) — a lease "lost" outcome, not a
        // transport-level failure. A drop with this null and a transport-
        // level reason is a different failure mode entirely.
        ownerChangedAtSec: c.ownerChangedAtMs !== null ? (c.ownerChangedAtMs - windowStartAt) / 1000 : null,
        // Phase 12: the gap between the last engine.io ping this socket
        // actually received and its disconnect. Small for all of them means
        // pings were flowing normally right up to the drop — a ping-timeout
        // explanation requires this gap to be large (>= pingTimeout, 20s by
        // default) for the sockets that time out.
        msSinceLastPing: c.lastPingAtMs !== null ? c.disconnectedAtMs! - c.lastPingAtMs : null,
        isIdleCanary: c.isIdleCanary,
      }));
    const ownerChangedCount = connected.filter((c) => c.ownerChangedAtMs !== null).length;

    // Phase 12: the discriminator that actually matters — how TIGHT is the
    // disconnect cluster, not just how many dropped. A per-socket cause
    // (ping timeout, individual network blip) spreads disconnects out over
    // roughly the same span the sockets connected over; a single shared
    // external event (e.g. the port-forward relay closing its tunneled
    // connections) collapses them into a spread of milliseconds regardless
    // of how spread out the connects were. See the Phase 12 plan's reading
    // table for exact thresholds.
    const dropTimesSec = droppedSockets.map((d) => d.disconnectedAtSec);
    const dropSpread =
      dropTimesSec.length > 1
        ? { minSec: Math.min(...dropTimesSec), maxSec: Math.max(...dropTimesSec), spreadMs: (Math.max(...dropTimesSec) - Math.min(...dropTimesSec)) * 1000 }
        : null;
    const idleCanaryDropped = droppedSockets.filter((d) => d.isIdleCanary).length;
    const idleCanaryTotal = connected.filter((c) => c.isIdleCanary).length;

    const socketSurvival = {
      initial: connected.length,
      survivedWindow: connected.length - droppedSockets.length,
      ownerChangedCount,
      dropSpread,
      idleCanary: { total: idleCanaryTotal, dropped: idleCanaryDropped },
      dropped: droppedSockets,
    };

    const worst = (pick: (s: IntervalSample) => number) => (intervals.length ? Math.max(...intervals.map(pick)) : 0);
    const mid = (pick: (s: IntervalSample) => number) => median(intervals.map(pick));

    const cpuSamples = intervals.map((s) => s.cpuPctOfOneCore);
    const totalDuration = intervals.reduce((sum, s) => sum + s.durationSec, 0);
    const cpu = {
      medianPctOfOneCore: median(cpuSamples),
      peakPctOfOneCore: cpuSamples.length ? Math.max(...cpuSamples) : 0,
      sustainedAvgPctOfOneCore:
        totalDuration > 0 ? intervals.reduce((sum, s) => sum + s.cpuPctOfOneCore * s.durationSec, 0) / totalDuration : 0,
    };
    const serverCores = Number(process.env.LOAD_HARNESS_SERVER_CORES ?? "4");
    const cpuOfServer = {
      cores: serverCores,
      medianPct: cpu.medianPctOfOneCore / serverCores,
      peakPct: cpu.peakPctOfOneCore / serverCores,
      sustainedAvgPct: cpu.sustainedAvgPctOfOneCore / serverCores,
    };

    const rssValues = intervals.map((s) => s.rssMb);
    const rss = {
      startMb: rssValues[0] ?? 0,
      endMb: rssValues[rssValues.length - 1] ?? 0,
      peakMb: rssValues.length ? Math.max(...rssValues) : 0,
      ...rssStability(intervals),
    };

    const gate = {
      tickP95: { worstMs: worst((s) => s.tickP95Ms), limitMs: GATE.tickP95Ms },
      tickP99: { worstMs: worst((s) => s.tickP99Ms), limitMs: GATE.tickP99Ms },
      eventLoopP99: { worstMs: worst((s) => s.eventLoopP99Ms), limitMs: GATE.eventLoopP99Ms },
      corrections: { movesSent, corrections, ratePct: correctionRatePct, limitPct: GATE.correctionRatePct },
      joins: { expected: n, joined: connected.length, rejected: rejectedCount, failed: joinFailures },
      rssStable: rss.stable,
    };
    const checks = {
      tickP95: gate.tickP95.worstMs <= GATE.tickP95Ms,
      tickP99: gate.tickP99.worstMs <= GATE.tickP99Ms,
      eventLoopP99: gate.eventLoopP99.worstMs <= GATE.eventLoopP99Ms,
      corrections: correctionRatePct <= GATE.correctionRatePct,
      joins: connected.length === n && rejectedCount === 0 && joinFailures === 0,
      // Too few intervals to judge growth (short windows) is not a failure.
      rssStable: rss.stable !== false,
      hasIntervals: intervals.length > 0,
      // Only when churn was requested, so ordinary runs are judged as before.
      // Occupancy must be back at n (an old socket's stale disconnect deleting
      // the live peer would leave it short), every requested reconnect must
      // have happened, and the server must report having ignored stale
      // disconnects — 0 would mean the race was never actually exercised.
      ...(churn.requested > 0
        ? {
            reconnectOccupancy:
              churn.performed === churn.requested && churn.failed === 0 && churn.occupancyAfter === n,
            staleGuardFired: (finalMetrics?.staleDisconnectsIgnored ?? 0) > 0,
          }
        : {}),
      // Whenever the server reports the counters: updates received must match updates sent.
      ...(proximityDelivery ? { proximityDelivery: proximityDelivery.ok } : {}),
    };
    passed = Object.values(checks).every(Boolean);

    const phaseMedians = {
      positions: mid((s) => s.phaseAvgMs.positions),
      proximity: mid((s) => s.phaseAvgMs.proximity),
      zone: mid((s) => s.phaseAvgMs.zone),
      audioEmit: mid((s) => s.phaseAvgMs.audioEmit),
    };

    const mark = (ok: boolean) => (ok ? "PASS" : "FAIL");
    console.log(
      `  intervals sampled: ${intervals.length}/${pollAttempts} polls over ${fmt(windowElapsedSec, 1)}s` +
        (metricsPollFailures > 0 ? `  <-- ${metricsPollFailures} metrics poll(s) FAILED` : ""),
    );
    console.log(
      `  socket survival: ${socketSurvival.survivedWindow}/${socketSurvival.initial} still connected at window end` +
        (droppedSockets.length > 0 ? `  <-- ${droppedSockets.length} DROPPED mid-run: ${JSON.stringify(droppedSockets.slice(0, 5))}${droppedSockets.length > 5 ? "…" : ""}` : ""),
    );
    if (dropSpread) {
      console.log(
        `  drop spread: ${fmt(dropSpread.spreadMs, 1)}ms (first at ${fmt(dropSpread.minSec, 3)}s, last at ${fmt(dropSpread.maxSec, 3)}s)` +
          (dropSpread.spreadMs < 1000
            ? "  <-- SIMULTANEOUS: rules out a per-socket cause (e.g. ping timeout); points to one shared external event"
            : ""),
      );
    }
    if (idleCanaryTotal > 0) {
      console.log(
        `  idle canaries (no seat, no move): ${idleCanaryTotal - idleCanaryDropped}/${idleCanaryTotal} survived` +
          (idleCanaryDropped > 0 && idleCanaryDropped === idleCanaryTotal
            ? "  <-- idle sockets died too: the cut is TIME-based, not traffic-induced"
            : idleCanaryDropped === 0 && droppedSockets.length > 0
              ? "  <-- idle sockets survived while busy ones dropped: points to traffic/load, not a fixed timeout"
              : ""),
      );
    }
    console.log(
      `  owner:changed received: ${ownerChangedCount}/${socketSurvival.initial}` +
        (ownerChangedCount > 0 ? "  <-- the SERVER evicted this room (lease lost) — see /internal/metrics's lease counters" : ""),
    );
    if (finalMetrics?.lease) {
      const l = finalMetrics.lease;
      console.log(`  server lease outcomes (cumulative): renewed ${l.renewed} · reclaimed ${l.reclaimed} · lost ${l.lost} · errors ${l.errors}`);
    }
    if (finalMetrics?.join) {
      const j = finalMetrics.join;
      console.log(`  server-side join latency: avg ${fmt(j.avgMs, 1)}ms  p50 ${fmt(j.p50Ms, 1)}ms  p95 ${fmt(j.p95Ms, 1)}ms  p99 ${fmt(j.p99Ms, 1)}ms  (n=${j.sampleCount}, <= 200ms avg target)`);
    }
    if (serverProximity && proximityDelivery) {
      console.log(
        `  proximity (mode: ${PROXIMITY_BATCH ? "batched" : "per-peer"}): server sent ${serverProximity.updates} updates in ${serverProximity.batchFrames + serverProximity.legacyFrames} frames (batch ${serverProximity.batchFrames} carrying ${serverProximity.batchedUpdates}, per-peer ${serverProximity.legacyFrames}) · clients received ${clientProximityUpdates} updates in ${clientProximityFrames.batch + clientProximityFrames.update} frames (batch ${clientProximityFrames.batch}, per-peer ${clientProximityFrames.update}) · received/sent ${proximityDelivery.ratio === null ? "n/a" : proximityDelivery.ratio.toFixed(4)} ${mark(proximityDelivery.ok)} (validity check: a FAIL means this run's numbers do not count)`,
      );
    }
    if (churn.requested > 0) {
      console.log(
        `  reconnect churn: ${churn.performed}/${churn.requested} performed (failed ${churn.failed}) · occupancy after churn ${churn.occupancyAfter ?? "n/a"} (expected ${n}) ${mark(checks.reconnectOccupancy === true)} · server stale disconnects ignored ${finalMetrics?.staleDisconnectsIgnored ?? "n/a"} ${mark(checks.staleGuardFired === true)}`,
      );
    }
    if (finalMetrics?.disconnectReasons && Object.keys(finalMetrics.disconnectReasons).length > 0) {
      console.log(`  server-observed disconnect reasons (cumulative): ${JSON.stringify(finalMetrics.disconnectReasons)}`);
    }
    if (finalMetrics?.transientDbRetryAttempts) {
      console.log(`  Postgres transient-retry attempts (cumulative, process lifetime): ${finalMetrics.transientDbRetryAttempts}`);
    }
    if (finalMetrics?.heartbeat) {
      const hb = finalMetrics.heartbeat;
      console.log(
        `  server heartbeat (sampled ${hb.sampledConnections} conn, cumulative): pings sent ${hb.pingsSent} · pongs received ${hb.pongsReceived} · max pong latency ${fmt(hb.maxPongLatencyMs, 1)}ms` +
          (hb.pongsReceived < hb.pingsSent ? "  <-- some pings never got a pong back" : ""),
      );
    }
    if (finalMetrics?.moveValidation) {
      // Phase 15 Part B: NOT evidence on its own for what's causing
      // rejections — see the Phase 15 plan's explicit guard. This is the
      // direct per-move observation the guard calls for: comparing the
      // elapsed-since-last-accepted-move distribution for accepted vs
      // rejected moves is what would show the "double-drain" collapse
      // (rejected elapsed near 0 while accepted elapsed clusters near the
      // real move interval), not any aggregate tick/event-loop number.
      const { accepted, rejected, windows = [] } = finalMetrics.moveValidation;
      const groupLine = (label: string, group: TickWindowSample[]) =>
        `  tick windows ${label}: n=${group.length} · median ELU ${group.length ? fmt(median(group.map((w) => w.elu)), 3) : "n/a"} · median cpu/wall ${group.length ? fmt(median(group.map((w) => w.cpuWallRatio)), 3) : "n/a"} · median tick ${group.length ? fmt(median(group.map((w) => w.tickMs)), 2) + "ms" : "n/a"}`;
      console.log(groupLine("WITH cluster (>=2 users, same 10ms)", windows.filter((w) => w.maxClusterUsers >= 2)));
      console.log(groupLine("WITHOUT cluster", windows.filter((w) => w.maxClusterUsers < 2)));
      const summarize = (samples: { elapsedMs: number }[]) => {
        if (samples.length === 0) return "n=0";
        const sorted = [...samples.map((s) => s.elapsedMs)].sort((a, b) => a - b);
        const mid = sorted[Math.floor(sorted.length / 2)]!;
        return `n=${sorted.length} elapsedMs min=${fmt(sorted[0]!, 1)} median=${fmt(mid, 1)} max=${fmt(sorted[sorted.length - 1]!, 1)}`;
      };
      console.log(`  move validation samples — accepted (1-in-20): ${summarize(accepted)}`);
      console.log(`  move validation samples — rejected (all, newest ${rejected.length}): ${summarize(rejected)}`);
      if (rejected.length > 0) {
        const r = summarizeRejections(rejected);
        console.log(
          `  rejected moves, arrival vs emit gap (n=${r.samplesWithGaps}): server gap median ${r.serverGapMedianMs === null ? "n/a" : fmt(r.serverGapMedianMs, 1) + "ms"} · client gap median ${r.clientGapMedianMs === null ? "n/a" : fmt(r.clientGapMedianMs, 1) + "ms"}`,
        );
        console.log(
          `  rejected moves sharing a ${r.clustering.bucketMs}ms server instant with a different user: ${r.clustering.observedSharedSamples}/${rejected.length} observed · ${fmt(r.clustering.expectedSharedByChance, 1)} expected by chance (span ${fmt(r.clustering.spanMs / 1000, 1)}s) · largest bucket ${r.clustering.largestBucketDistinctUsers} distinct users`,
        );
      }
    }
    for (const line of formatStallReport({
      windows: finalMetrics?.moveValidation?.windows ?? [],
      emitTail: finalMetrics?.emitTail,
      gc: finalMetrics?.gc,
    })) {
      console.log(line);
    }
    if (intervals.length > 0) {
      const occSamples = intervals.filter((s) => s.occupancyActive !== null);
      if (occSamples.length > 0) {
        const activeValues = occSamples.map((s) => s.occupancyActive!);
        console.log(
          `  server-reported occupancy over window: min ${Math.min(...activeValues)} · max ${Math.max(...activeValues)} · last ${activeValues[activeValues.length - 1]} (expected ${n})`,
        );
      } else {
        console.log("  server-reported occupancy: no successful polls (occupancy route unreachable or not wired up)");
      }
    }
    console.log(`  tick p95  median ${fmt(mid((s) => s.tickP95Ms))}ms  worst ${fmt(gate.tickP95.worstMs)}ms  (<= ${GATE.tickP95Ms}) ${mark(checks.tickP95)}`);
    console.log(`  tick p99  median ${fmt(mid((s) => s.tickP99Ms))}ms  worst ${fmt(gate.tickP99.worstMs)}ms  (<= ${GATE.tickP99Ms}) ${mark(checks.tickP99)}`);
    console.log(`  event-loop p99  median ${fmt(mid((s) => s.eventLoopP99Ms))}ms  worst ${fmt(gate.eventLoopP99.worstMs)}ms  (<= ${GATE.eventLoopP99Ms}) ${mark(checks.eventLoopP99)}`);
    console.log(
      `  harness event-loop (this box, NOT the server) p50 median ${fmt(mid((s) => s.harnessEventLoopP50Ms))}ms  p99 median ${fmt(mid((s) => s.harnessEventLoopP99Ms))}ms  worst ${fmt(worst((s) => s.harnessEventLoopMaxMs))}ms` +
        (worst((s) => s.harnessEventLoopMaxMs) > 1000
          ? "  <-- this 2-core box's own event loop is stalling for seconds — a likely cause of missed Socket.IO heartbeats, separate from the server or the tunnel"
          : ""),
    );
    console.log(
      `  moves sent ${movesSent.toLocaleString("en-US")} · corrections ${corrections.toLocaleString("en-US")} · rate ${correctionRatePct.toFixed(4)}%  (<= ${GATE.correctionRatePct}%) ${mark(checks.corrections)}`,
    );
    if (corrections > 0) console.log(`  correction reasons: ${JSON.stringify(correctionReasons)}`);
    console.log(`  joins ${connected.length}/${n}, rejected ${rejectedCount}, failed ${joinFailures} ${mark(checks.joins)}`);
    console.log(
      `  RSS start ${fmt(rss.startMb, 1)}MB · end ${fmt(rss.endMb, 1)}MB · peak ${fmt(rss.peakMb, 1)}MB · ` +
        (rss.stable === null ? "stability: not enough intervals" : `stable ${mark(checks.rssStable)} (${fmt(rss.firstThirdMb, 1)} -> ${fmt(rss.lastThirdMb, 1)}MB)`),
    );
    console.log(`  (report) tick p50 median ${fmt(mid((s) => s.tickP50Ms))}ms · max tick worst ${fmt(worst((s) => s.tickMaxMs))}ms`);
    console.log(
      `  (report) server CPU, % of one core: median ${fmt(cpu.medianPctOfOneCore, 1)} · peak ${fmt(cpu.peakPctOfOneCore, 1)} · sustained ${fmt(cpu.sustainedAvgPctOfOneCore, 1)}` +
        `  | % of ${serverCores} cores: median ${fmt(cpuOfServer.medianPct, 1)} · peak ${fmt(cpuOfServer.peakPct, 1)} · sustained ${fmt(cpuOfServer.sustainedAvgPct, 1)}`,
    );
    console.log(
      `  (report) phase avg medians: positions ${fmt(phaseMedians.positions)} · proximity ${fmt(phaseMedians.proximity)} · zone ${fmt(phaseMedians.zone)} · audioEmit ${fmt(phaseMedians.audioEmit)} ms`,
    );
    console.log(
      `  (report) events received ~${fmt(totalEvents / windowElapsedSec, 0)}/s · client bytes ${fmt(bytesReceived / windowElapsedSec / 1024, 1)} KB/s · redis publishes/s median ${fmt(mid((s) => s.redisPublishesPerSec), 1)}`,
    );
    console.log(`  GATE: ${passed ? "PASS" : "FAIL"}`);

    writeResultJson(n, scenario, {
      label: LABEL,
      n,
      scenario,
      timestamp: new Date().toISOString(),
      realtimeUrl: REALTIME_URL,
      windowSec: WINDOW_MS / 1000,
      windowElapsedSec,
      gatePassed: passed,
      checks,
      gate,
      cpu: { ...cpu, ofServer: cpuOfServer },
      rss,
      joinLatencyMs: joinLatency,
      layoutId: LAYOUT.id,
      seatedFraction: SEATED_FRACTION,
      seated: seatTargets.length,
      seatClaims: seatSummary,
      walkToSeat: WALK_TO_SEAT,
      walkPhase: {
        totalDurationMs: walkPhaseTotalDurationMs,
        attempted: walkPhaseRecords.length,
        accepted: walkPhaseRecords.filter((r) => r.ackOk).length,
        totalCorrectionsDuringWalk: totalWalkCorrections,
        usersWithCorrectionDuringWalk: walkPhaseRecords.filter((r) => r.correctionsAfterWalk > r.correctionsBeforeWalk).length,
        totalReconciledMidWalk: totalReconciled,
        failures: {
          total: failed.length,
          rejectedMoveImplicated: failedWithWalkCorrection.length,
          walkDidNotConverge: failedDidNotConverge.length,
          convergedButStillRefused: failedConvergedButRefused.length,
          convergedButStillRefusedReasons: failedConvergedButRefused.reduce((acc: Record<string, number>, r) => {
            const key = r.ackReason ?? "no_reply";
            acc[key] = (acc[key] ?? 0) + 1;
            return acc;
          }, {}),
        },
        duplicateSeatIds,
        distinctSeatsClaimed: new Set(seatIdsClaimed).size,
      },
      movesSent,
      corrections,
      correctionRatePct,
      correctionReasons: { ...correctionReasons },
      eventsReceivedPerSec: totalEvents / windowElapsedSec,
      clientBytesPerSec: bytesReceived / windowElapsedSec,
      phaseAvgMedians: phaseMedians,
      // Phase 10c diagnostics — see the plan for what these are checking.
      pollAttempts,
      metricsPollFailures,
      socketSurvival,
      intervals,
      // Phase 11/12 diagnostics — server's own bookkeeping, read once right
      // after the window closes (see finalMetrics's docs above).
      serverLease: finalMetrics?.lease ?? null,
      serverJoinLatency: finalMetrics?.join ?? null,
      serverDisconnectReasons: finalMetrics?.disconnectReasons ?? null,
      serverTransientDbRetryAttempts: finalMetrics?.transientDbRetryAttempts ?? null,
      // Phase 16: reconnect churn and the server's stale-disconnect counter.
      reconnectChurn: churn,
      serverStaleDisconnectsIgnored: finalMetrics?.staleDisconnectsIgnored ?? null,
      proximityMode: PROXIMITY_BATCH ? "batched" : "per-peer",
      proximityDelivery: serverProximity && proximityDelivery ? { server: serverProximity, clientUpdates: clientProximityUpdates, clientFrames: clientProximityFrames, ...proximityDelivery } : null,
      // Phase 15 Part A diagnostic.
      rejectionSamples,
      // Phase 14 heartbeat instrumentation, finally surfaced (it was added
      // to /internal/metrics but never read here — see the Phase 15 plan).
      serverHeartbeat: finalMetrics?.heartbeat ?? null,
      // Phase 15 Part B diagnostic — raw samples for offline inspection.
      serverMoveValidation: finalMetrics?.moveValidation ?? null,
      // Phase 17: raw emit-tail and GC records, for offline analysis.
      serverEmitTail: finalMetrics?.emitTail ?? null,
      serverGc: finalMetrics?.gc ?? null,
      rejectedMoveSummary:
        finalMetrics?.moveValidation && finalMetrics.moveValidation.rejected.length > 0
          ? summarizeRejections(finalMetrics.moveValidation.rejected)
          : null,
    });

    if (n === 200 && !limitOverrideNote) {
      const extra = users[n]!;
      try {
        const result = await connectSocket(mintToken(extra.id, extra.email), extra.id, roomId);
        const ack = result.ack as { error?: string; limit?: number; active?: number };
        if (ack.error === "workspace_full") {
          console.log(`  OK: 201st join rejected (active=${ack.active}, limit=${ack.limit})`);
        } else {
          console.error(`  FAIL: expected workspace_full for the 201st join, got ${JSON.stringify(ack)}`);
        }
        result.socket.disconnect();
      } catch (err) {
        console.error(`  201st join check could not connect: ${(err as Error).message}`);
      }
    }
  } finally {
    for (const c of connected) c.socket.disconnect();
    await teardownWorkspace(
      workspaceId,
      users.map((u) => u.id),
    );
  }

  return passed;
}

async function main(): Promise<void> {
  const metrics = await fetchMetrics();
  if (!metrics) {
    console.error(`Could not reach ${METRICS_URL}. Start the realtime server first.`);
    process.exit(1);
  }
  console.log(`Connected to realtime instance ${metrics.instanceId} at ${REALTIME_URL}.`);

  const onlyN = process.env.LOAD_HARNESS_ONLY_N ? Number(process.env.LOAD_HARNESS_ONLY_N) : null;
  const onlyScenario = process.env.LOAD_HARNESS_ONLY_SCENARIO as Scenario | undefined;
  let allPassed = true;

  for (const n of onlyN ? [onlyN] : [50, 100, 200]) {
    if (!onlyScenario || onlyScenario === "spread") allPassed = (await runPhase(n, "spread")) && allPassed;
    if (!onlyScenario || onlyScenario === "cluster") allPassed = (await runPhase(n, "cluster")) && allPassed;
  }

  if (process.env.LOAD_HARNESS_INCLUDE_500 === "1") {
    const note = "dev-only limit override, NOT a real plan limit";
    if (!onlyScenario || onlyScenario === "spread") allPassed = (await runPhase(500, "spread", note)) && allPassed;
    if (!onlyScenario || onlyScenario === "cluster") allPassed = (await runPhase(500, "cluster", note)) && allPassed;
  }

  process.exitCode = allPassed ? 0 : 3;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
