/**
 * EXPERIMENT (read-only, not used by the server): does coalescing a tick's worth
 * of small Socket.IO frames per socket into one flush cut the send-side cost?
 *
 * Server and N real Socket.IO clients (websocket transport) on loopback; the
 * clients run in a child process so their receive work does not share the
 * server's event loop. Each 100ms round the server emits FRAMES small
 * `proximity:update`-shaped events to every socket, two ways, alternated in
 * blocks so drift hits both equally:
 *   plain   the way the server does it today (one WebSocket frame -> one writev)
 *   corked  cork() each socket's underlying net.Socket, emit, uncork() once
 *           (uncork is in a finally: a missed uncork would silence the socket)
 * Numbers only, no verdict. Every started resource is closed at the end.
 *
 *   CORK_BENCH_SOCKETS=100 CORK_BENCH_FRAMES=22 CORK_BENCH_BLOCKS=5 CORK_BENCH_ROUNDS=60
 *   pnpm --filter @cosmos/realtime exec tsx src/scripts/experiments/corkBench.ts
 */
import { fork } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { performance } from "node:perf_hooks";
import { Server, type Socket } from "socket.io";
import { io as connect } from "socket.io-client";

const SOCKETS = Number(process.env.CORK_BENCH_SOCKETS ?? 100);
const FRAMES = Number(process.env.CORK_BENCH_FRAMES ?? 22);
const BLOCKS = Number(process.env.CORK_BENCH_BLOCKS ?? 5);
const ROUNDS = Number(process.env.CORK_BENCH_ROUNDS ?? 60);
const WARMUP = Number(process.env.CORK_BENCH_WARMUP ?? 20);
const PERIOD_MS = 100;
const EVENT = "proximity:update";

type Mode = "plain" | "corked";

// ---------------------------------------------------------------- child ----
async function runChild(url: string): Promise<void> {
  const received: Record<string, number> = { plain: 0, corked: 0 };
  let outOfOrder = 0;
  const lastSeq = new Map<number, number>();
  const clients = Array.from({ length: SOCKETS }, (_, id) => {
    const c = connect(url, { transports: ["websocket"], forceNew: true });
    c.on(EVENT, (p: { m: Mode; n: number }) => {
      received[p.m]! += 1;
      const prev = lastSeq.get(id) ?? -1;
      if (p.n <= prev) outOfOrder++;
      lastSeq.set(id, p.n);
    });
    return c;
  });
  await Promise.all(clients.map((c) => new Promise<void>((resolve) => c.on("connect", () => resolve()))));
  process.send!({ type: "ready" });
  process.on("message", (msg: { type: string }) => {
    if (msg.type !== "finish") return;
    process.send!({ type: "result", received, outOfOrder }, () => {
      for (const c of clients) c.close();
      process.exit(0);
    });
  });
}

// --------------------------------------------------------------- parent ----
const percentile = (values: number[], p: number): number => {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
};
const f = (x: number) => x.toFixed(2);

interface Sample {
  syncMs: number;
  burstMs: number;
  userMs: number;
  sysMs: number;
}

type Corkable = { cork?: () => void; uncork?: () => void };

async function runParent(): Promise<void> {
  const http = createServer();
  const io = new Server(http, { transports: ["websocket"], serveClient: false });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const serverSocketsPromise = new Promise<Socket[]>((resolve) => {
    const sockets: Socket[] = [];
    io.on("connection", (s) => {
      sockets.push(s);
      if (sockets.length === SOCKETS) resolve(sockets);
    });
  });
  const child = fork(process.argv[1]!, ["--child", url], { execArgv: process.execArgv });
  const childReady = new Promise<void>((resolve) =>
    child.on("message", (m: { type: string }) => m.type === "ready" && resolve()),
  );
  const serverSockets = await serverSocketsPromise;
  await childReady;

  // The underlying net.Socket of each Engine.IO WebSocket transport. Private
  // library internals: feature-detected, and the run says so if it is absent.
  const handles = serverSockets.map(
    (s) =>
      (s.conn as unknown as { transport?: { socket?: { _socket?: Corkable } } }).transport?.socket?._socket,
  );
  const corkable = handles.every((h) => typeof h?.cork === "function" && typeof h?.uncork === "function");

  const payload = { peerId: "user-0123456789ab", audioSubscribed: true, audioGain: 0.5, videoSubscribed: false };
  const sent: Record<Mode, number> = { plain: 0, corked: 0 };
  const samples: Record<Mode, Sample[]> = { plain: [], corked: [] };
  const seq = new Array<number>(SOCKETS).fill(0);

  async function round(mode: Mode, record: boolean): Promise<void> {
    const roundStart = performance.now();
    const cpu0 = process.cpuUsage();
    if (mode === "corked") for (const h of handles) h!.cork!();
    try {
      for (let i = 0; i < serverSockets.length; i++) {
        for (let k = 0; k < FRAMES; k++) {
          serverSockets[i]!.emit(EVENT, { ...payload, m: mode, n: seq[i]!++ });
          sent[mode]++;
        }
      }
    } finally {
      if (mode === "corked") for (const h of handles) h!.uncork!();
    }
    const syncMs = performance.now() - roundStart;
    await new Promise<void>((resolve) => setImmediate(resolve));
    const burstMs = performance.now() - roundStart;
    // Sleep out the rest of the period so the CPU delta covers every async flush.
    const wait = roundStart + PERIOD_MS - performance.now();
    if (wait > 0) await new Promise<void>((resolve) => setTimeout(resolve, wait));
    const cpu = process.cpuUsage(cpu0);
    if (record) samples[mode].push({ syncMs, burstMs, userMs: cpu.user / 1000, sysMs: cpu.system / 1000 });
  }

  try {
    const modes: Mode[] = corkable ? ["plain", "corked"] : ["plain"];
    for (let i = 0; i < WARMUP; i++) for (const m of modes) await round(m, false);
    for (let b = 0; b < BLOCKS; b++) {
      const order = b % 2 === 0 ? modes : [...modes].reverse();
      for (const m of order) for (let r = 0; r < ROUNDS; r++) await round(m, true);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 500)); // let the last flushes land

    const result = await new Promise<{ received: Record<Mode, number>; outOfOrder: number }>((resolve) => {
      child.on(
        "message",
        (m: { type: string; received: Record<Mode, number>; outOfOrder: number }) => m.type === "result" && resolve(m),
      );
      child.send({ type: "finish" });
    });

    console.log(
      `cork bench: ${SOCKETS} sockets x ${FRAMES} frames per round, ${BLOCKS} blocks x ${ROUNDS} rounds per mode, ${PERIOD_MS}ms period, node ${process.version}`,
    );
    console.log(
      `underlying net.Socket reachable via conn.transport.socket._socket on every socket: ${corkable ? "yes" : "NO (corked mode skipped)"}`,
    );
    for (const m of modes) {
      const s = samples[m];
      const col = (pick: (x: Sample) => number, p: number) => f(percentile(s.map(pick), p));
      console.log(`  ${m.padEnd(6)} rounds ${s.length}`);
      console.log(`    sync send loop ms             p50 ${col((x) => x.syncMs, 0.5)} · p90 ${col((x) => x.syncMs, 0.9)} · p99 ${col((x) => x.syncMs, 0.99)}`);
      console.log(`    send start -> check phase ms  p50 ${col((x) => x.burstMs, 0.5)} · p90 ${col((x) => x.burstMs, 0.9)} · p99 ${col((x) => x.burstMs, 0.99)}`);
      console.log(`    cpu per round ms              user p50 ${col((x) => x.userMs, 0.5)} · system p50 ${col((x) => x.sysMs, 0.5)} · user+system p50 ${col((x) => x.userMs + x.sysMs, 0.5)}`);
      console.log(
        `    frames sent ${sent[m]} · received by clients ${result.received[m]} · ${sent[m] === result.received[m] ? "all delivered" : "MISSING " + (sent[m] - result.received[m])}`,
      );
    }
    console.log(`  out-of-order frames seen by clients (per-socket sequence): ${result.outOfOrder}`);
  } finally {
    child.kill();
    io.close();
    http.close();
  }
}

if (process.argv[2] === "--child") void runChild(process.argv[3]!);
else void runParent().then(() => process.exit(0));
