/**
 * Load harness for the Phase 8 plan's final verification step: connects N
 * concurrent sockets into one Enterprise-plan (200-limit) workspace, seats
 * roughly half, walks the rest, and reports tick timing / event throughput /
 * process memory at N = 50, 100, 200 — plus confirms the (limit+1)th join
 * is rejected with workspace_full.
 *
 * A dev/ops tool, not a CI test: it needs a REAL running realtime server
 * (see apps/realtime's `dev` script) and a reachable Postgres/Redis (the
 * project's docker-compose). Run with:
 *
 *   pnpm --filter @cosmos/realtime run load-harness
 *
 * It provisions its own throwaway workspace/users/room per phase and
 * deletes them in a `finally`, so it's safe to run against a real dev
 * database without polluting it.
 */
import jwt from "jsonwebtoken";
import { io as ioClient, type Socket } from "socket.io-client";
import { prisma } from "@cosmos/db";
import { openOffice1, DEFAULT_LAYOUT_ID } from "@cosmos/shared";

const REALTIME_URL = process.env.REALTIME_URL ?? "http://localhost:4001";
const METRICS_URL = `${REALTIME_URL}/internal/metrics`;
const AUTH_SECRET = process.env.AUTH_SECRET ?? "dev-only-insecure-secret-change-me";
const MEASURE_WINDOW_MS = 8_000;
const MOVE_INTERVAL_MS = 50; // matches the real client's throttle (movement.ts)

interface Metrics {
  instanceId: string;
  uptimeSeconds: number;
  memoryUsage: NodeJS.MemoryUsage;
  tick: { sampleCount: number; avgMs: number; maxMs: number };
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

function mintToken(userId: string, email: string): string {
  // Same shape apps/web's session cookie carries — {sub, email} — verified
  // identically by apps/realtime's verifySessionToken (see src/auth.ts).
  return jwt.sign({ sub: userId, email }, AUTH_SECRET, { expiresIn: "1h" });
}

async function provisionWorkspace(n: number): Promise<{ workspaceId: string; roomId: string; users: { id: string; email: string }[] }> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspace = await prisma.workspace.create({
    data: { name: `Load Harness ${n} ${suffix}`, slug: `load-harness-${n}-${suffix}`, plan: "enterprise" },
  });

  const users: { id: string; email: string }[] = [];
  for (let i = 0; i < n + 1; i++) {
    // +1: one spare user to attempt the (limit+1)th join with, at N=200.
    const email = `load-harness-${suffix}-${i}@example.com`;
    const user = await prisma.user.create({ data: { email, name: `Load ${i}` } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "member" } });
    users.push({ id: user.id, email });
  }

  const room = await prisma.room.create({
    data: { workspaceId: workspace.id, name: "Load Harness Office", config: { layoutId: DEFAULT_LAYOUT_ID } },
  });

  return { workspaceId: workspace.id, roomId: room.id, users };
}

async function teardownWorkspace(workspaceId: string, userIds: string[]): Promise<void> {
  // Room/membership rows cascade from the workspace delete (see schema.prisma).
  await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  for (const userId of userIds) {
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  }
}

interface ConnectedSocket {
  socket: Socket;
  userId: string;
  eventCounts: Record<string, number>;
}

function connectSocket(token: string, userId: string, roomId: string): Promise<{ socket: Socket; joinLatencyMs: number; ack: unknown }> {
  return new Promise((resolve, reject) => {
    const socket = ioClient(REALTIME_URL, { auth: { token }, reconnection: false, timeout: 10_000 });
    const timer = setTimeout(() => reject(new Error(`connect timeout for ${userId}`)), 15_000);

    socket.on("connect", () => {
      const start = performance.now();
      socket.emit("join_room", { roomId }, (ack: unknown) => {
        clearTimeout(timer);
        resolve({ socket, joinLatencyMs: performance.now() - start, ack });
      });
    });
    socket.on("connect_error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function attachCounters(socket: Socket, counts: Record<string, number>): void {
  for (const event of ["peers:delta", "proximity:update", "occupancy:update", "seat:update", "zone:changed"]) {
    socket.on(event, () => {
      counts[event] = (counts[event] ?? 0) + 1;
    });
  }
}

async function runPhase(n: number): Promise<void> {
  console.log(`\n=== Phase: N=${n} concurrent (Enterprise limit) ===`);
  const { workspaceId, roomId, users } = await provisionWorkspace(n);
  const connected: ConnectedSocket[] = [];
  const joinLatencies: number[] = [];
  let rejectedCount = 0;

  try {
    const before = await fetchMetrics();

    // Join in small batches rather than all at once — mirrors real users
    // arriving over a few seconds, not a thundering herd the test harness
    // itself would never realistically produce.
    const BATCH_SIZE = 10;
    for (let i = 0; i < n; i += BATCH_SIZE) {
      const batch = users.slice(i, Math.min(i + BATCH_SIZE, n));
      const results = await Promise.allSettled(
        batch.map((u) => connectSocket(mintToken(u.id, u.email), u.id, roomId)),
      );
      results.forEach((result, idx) => {
        const user = batch[idx]!;
        if (result.status === "fulfilled") {
          const { socket, joinLatencyMs, ack } = result.value;
          if ((ack as { ok?: boolean })?.ok) {
            joinLatencies.push(joinLatencyMs);
            const eventCounts: Record<string, number> = {};
            attachCounters(socket, eventCounts);
            connected.push({ socket, userId: user.id, eventCounts });
          } else {
            rejectedCount += 1;
            socket.disconnect();
          }
        } else {
          console.error(`  join failed for ${user.email}:`, result.reason?.message ?? result.reason);
        }
      });
    }

    console.log(`  joined: ${connected.length}/${n} (rejected: ${rejectedCount})`);
    if (joinLatencies.length > 0) {
      const avg = joinLatencies.reduce((a, b) => a + b, 0) / joinLatencies.length;
      console.log(`  join latency: avg ${avg.toFixed(1)}ms, max ${Math.max(...joinLatencies).toFixed(1)}ms`);
    }

    // Seat roughly half (bounded by the layout's actual seat count — see
    // openOffice1), walk the rest.
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

    // Everyone NOT seated walks — periodic small moves at the real client
    // throttle, for the measurement window.
    const walkers = connected.filter((_, i) => !seatedUserIndices.has(i));
    const moveTimers = walkers.map((c) => {
      let x = Math.random() * 1000;
      let y = Math.random() * 1000;
      return setInterval(() => {
        x += (Math.random() - 0.5) * 10;
        y += (Math.random() - 0.5) * 10;
        c.socket.emit("move", { position: { x, y }, clientTs: Date.now() });
      }, MOVE_INTERVAL_MS);
    });

    await new Promise((resolve) => setTimeout(resolve, MEASURE_WINDOW_MS));
    moveTimers.forEach(clearInterval);

    const after = await fetchMetrics();
    const totalEvents = connected.reduce(
      (sum, c) => sum + Object.values(c.eventCounts).reduce((a, b) => a + b, 0),
      0,
    );
    const emitsPerSec = totalEvents / (MEASURE_WINDOW_MS / 1000);
    console.log(`  events received (all sockets): ${totalEvents} (~${emitsPerSec.toFixed(0)}/sec)`);

    if (after) {
      console.log(
        `  server tick: avg ${after.tick.avgMs.toFixed(2)}ms, max ${after.tick.maxMs.toFixed(2)}ms (${after.tick.sampleCount} samples)`,
      );
      const beforeRssMb = (before?.memoryUsage.rss ?? 0) / 1024 / 1024;
      const afterRssMb = after.memoryUsage.rss / 1024 / 1024;
      console.log(`  server RSS: ${beforeRssMb.toFixed(1)}MB -> ${afterRssMb.toFixed(1)}MB`);
    } else {
      console.log("  (no /internal/metrics response — is the realtime dev server running?)");
    }

    // Confirm the (limit+1)th join is rejected with workspace_full — only
    // meaningful once every earlier slot is actually occupied, so this only
    // runs for the N=200 (== the Enterprise limit) phase.
    if (n === 200) {
      const extra = users[n]!;
      const result = await connectSocket(mintToken(extra.id, extra.email), extra.id, roomId);
      const ack = result.ack as { error?: string; limit?: number; active?: number };
      console.log(`  (limit+1)th join ack: ${JSON.stringify(ack)}`);
      if (ack.error !== "workspace_full") {
        console.error(`  FAIL: expected workspace_full, got ${JSON.stringify(ack)}`);
      } else {
        console.log(`  OK: 201st join correctly rejected (active=${ack.active}, limit=${ack.limit})`);
      }
      result.socket.disconnect();
    }
  } finally {
    for (const c of connected) c.socket.disconnect();
    await teardownWorkspace(
      workspaceId,
      users.map((u) => u.id),
    );
  }
}

async function main(): Promise<void> {
  const metrics = await fetchMetrics();
  if (!metrics) {
    console.error(`Could not reach ${METRICS_URL} — start the realtime dev server first (pnpm --filter @cosmos/realtime run dev).`);
    process.exit(1);
  }
  console.log(`Connected to realtime instance ${metrics.instanceId}.`);

  for (const n of [50, 100, 200]) {
    await runPhase(n);
  }

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
