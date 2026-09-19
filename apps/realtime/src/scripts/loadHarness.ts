/**
 * Load harness for realtime scaling verification. Connects N Socket.IO
 * clients into one workspace, seats roughly half, walks the rest, and
 * measures the server over a steady-state window.
 *
 * Talks ONLY to the realtime server (REALTIME_URL): workspace/user/room
 * fixtures are created and removed through the server's dev-only
 * /internal/load-harness/* routes (start the server with
 * LOAD_HARNESS_ENABLED=1), so the load generator needs no database access
 * and can run on a separate machine. JWTs are minted locally with the shared
 * AUTH_SECRET.
 *
 *   pnpm --filter @cosmos/realtime run load-harness
 *
 * Env:
 *   REALTIME_URL                 default http://localhost:4001
 *   AUTH_SECRET                  must match the server
 *   LOAD_HARNESS_LABEL           tags the result file (default "local")
 *   LOAD_HARNESS_WINDOW_SEC      measurement window, default 8 (use 600 for validation)
 *   LOAD_HARNESS_ONLY_N          run a single N instead of 50/100/200
 *   LOAD_HARNESS_ONLY_SCENARIO   spread | cluster
 *   LOAD_HARNESS_INCLUDE_500=1   also run N=500 (server needs LOAD_HARNESS_LIMIT_OVERRIDE=500)
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
import jwt from "jsonwebtoken";
import { io as ioClient, type Socket } from "socket.io-client";
import { openOffice1, DEFAULT_MOVEMENT_CONFIG, movementConfigForLayout, type Point } from "@cosmos/shared";

const ROOM_MOVEMENT_CONFIG = movementConfigForLayout(openOffice1, DEFAULT_MOVEMENT_CONFIG);

const REALTIME_URL = process.env.REALTIME_URL ?? "http://localhost:4001";
const METRICS_URL = `${REALTIME_URL}/internal/metrics`;
const AUTH_SECRET = process.env.AUTH_SECRET ?? "dev-only-insecure-secret-change-me";
const WINDOW_MS = Math.max(1, Number(process.env.LOAD_HARNESS_WINDOW_SEC ?? "8")) * 1000;
const POLL_INTERVAL_MS = 10_000;
const MOVE_INTERVAL_MS = 50;
// Displacement is sized from real elapsed time so a late timer never implies
// a teleport; 400px/s is well under maxSpeedPxPerSec.
const WANDER_SPEED_PX_PER_SEC = 400;
const LABEL = process.env.LOAD_HARNESS_LABEL ?? "local";
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
  return postJson<Workspace>("/internal/load-harness/provision", { n });
}

async function teardownWorkspace(workspaceId: string, userIds: string[]): Promise<void> {
  await postJson("/internal/load-harness/teardown", { workspaceId, userIds }).catch((err) =>
    console.error("  teardown failed:", (err as Error).message),
  );
}

function mintToken(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, AUTH_SECRET, { expiresIn: "1h" });
}

interface ConnectedSocket {
  socket: Socket;
  userId: string;
  spawnPosition: Point;
  eventCounts: Record<string, number>;
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
      socket.emit("join_room", { roomId }, (ack: unknown) => {
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
  for (const event of ["peers:delta", "proximity:update", "occupancy:update", "seat:update", "zone:changed"]) {
    entry.socket.on(event, () => {
      entry.eventCounts[event] = (entry.eventCounts[event] ?? 0) + 1;
    });
  }
  entry.socket.on("move:correction", (payload: { reason?: string }) => {
    const reason = payload.reason ?? "unknown";
    correctionReasons[reason] = (correctionReasons[reason] ?? 0) + 1;
    entry.corrections++;
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

  const engine = (entry.socket.io as unknown as { engine?: { on(event: string, cb: (packet: { data?: unknown }) => void): void } }).engine;
  engine?.on("packet", (packet) => {
    if (typeof packet.data === "string") entry.bytesReceived += packet.data.length;
    else if (packet.data && typeof (packet.data as { length?: number }).length === "number") {
      entry.bytesReceived += (packet.data as { length: number }).length;
    }
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

  const poll = async () => {
    pollAttempts++;
    const [m, occ] = await Promise.all([fetchMetrics(), fetchOccupancy(roomId)]);
    const now = performance.now();
    if (m) {
      samples.push(toIntervalSample(m, occ, (now - windowStartAt) / 1000, (now - lastAt) / 1000));
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
              corrections: 0,
              bytesReceived: 0,
              disconnectedAtMs: null,
              disconnectReason: null,
            };
            attachCounters(entry);
            connected.push(entry);
          } else {
            rejectedCount += 1;
            socket.disconnect();
          }
        } else {
          joinFailures += 1;
          console.error(`  join failed for ${user.email}:`, result.reason?.message ?? result.reason);
        }
      });
    }

    console.log(`  joined: ${connected.length}/${n} (rejected: ${rejectedCount}, failed: ${joinFailures})`);
    const joinLatency = joinLatencies.length > 0 ? summarizeLatencies(joinLatencies) : null;
    if (joinLatency) {
      console.log(`  join latency: avg ${fmt(joinLatency.avg, 1)}ms, p95 ${fmt(joinLatency.p95, 1)}ms, max ${fmt(joinLatency.max, 1)}ms`);
    }

    const seatTargets = openOffice1.seats.slice(0, Math.min(connected.length, Math.floor(n / 2), openOffice1.seats.length));
    const seatedUserIndices = new Set(seatTargets.map((_, i) => i));
    await Promise.all(
      seatTargets.map(
        (seat, i) =>
          new Promise<void>((resolve) => {
            connected[i]!.socket.emit("seat:claim", { seatId: seat.id }, () => resolve());
          }),
      ),
    );
    console.log(`  seated: ${seatTargets.length}`);

    // Reset counters and the server's "since last read" deltas so everything
    // below describes only the steady-state window.
    for (const c of connected) {
      c.eventCounts = {};
      c.corrections = 0;
      c.bytesReceived = 0;
    }
    for (const key of Object.keys(correctionReasons)) delete correctionReasons[key];
    await fetchMetrics();
    const windowStartAt = performance.now();
    const poller = startMetricsPoller(windowStartAt, roomId);

    let movesSent = 0;
    const walkers = connected.filter((_, i) => !seatedUserIndices.has(i));
    const clusterCenter = walkers[0]?.spawnPosition ?? { x: 880, y: 880 };
    const moveTimers = walkers.map((c) => {
      let { x, y } = scenario === "cluster" ? clusterCenter : c.spawnPosition;
      let lastSentAt = performance.now();
      return setInterval(() => {
        const now = performance.now();
        const { dx, dy } = randomStep(Math.max(0, (now - lastSentAt) / 1000));
        lastSentAt = now;
        x = clampToFloor(x + dx, ROOM_MOVEMENT_CONFIG.roomWidthPx);
        y = clampToFloor(y + dy, ROOM_MOVEMENT_CONFIG.roomHeightPx);
        c.socket.emit("move", { position: { x, y }, clientTs: Date.now() });
        movesSent++;
      }, MOVE_INTERVAL_MS);
    });

    await new Promise((resolve) => setTimeout(resolve, WINDOW_MS));
    moveTimers.forEach(clearInterval);
    const windowElapsedSec = (performance.now() - windowStartAt) / 1000;
    const { samples: intervals, pollAttempts, metricsPollFailures } = await poller.stop();

    const totalEvents = connected.reduce((sum, c) => sum + Object.values(c.eventCounts).reduce((a, b) => a + b, 0), 0);
    const corrections = connected.reduce((sum, c) => sum + c.corrections, 0);
    const bytesReceived = connected.reduce((sum, c) => sum + c.bytesReceived, 0);
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
      }));
    const socketSurvival = {
      initial: connected.length,
      survivedWindow: connected.length - droppedSockets.length,
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
      seated: seatTargets.length,
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
