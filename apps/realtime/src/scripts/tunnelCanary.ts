/**
 * Phase 12 diagnostic: a pure-transport canary for the two-Codespace load
 * test topology. Opens a handful of raw TCP connections through the SAME
 * `gh codespace ports forward` tunnel the load harness uses, sends no
 * application traffic on them at all (no HTTP, no Socket.IO), holds them for
 * a fixed duration, and reports exactly when each one closes.
 *
 * This exists to answer one question cleanly: is the relay itself closing
 * established connections after some fixed lifetime, independent of the
 * realtime server or the load it's under? If these canaries die together at
 * the same point a loaded run's sockets died, the server is exonerated
 * completely — it's a property of the tunnel. If they survive the full
 * duration, the cause is somewhere in the app or the protocol traffic, not a
 * bare connection-lifetime limit.
 *
 *   REALTIME_URL=http://localhost:4001 npx tsx src/scripts/tunnelCanary.ts
 *
 * Env:
 *   REALTIME_URL              default http://localhost:4001 (host:port parsed from this)
 *   TUNNEL_CANARY_COUNT       default 5
 *   TUNNEL_CANARY_DURATION_SEC  default 120 — comfortably past the ~55s this
 *                              investigation is chasing
 *
 * Self-terminating: every socket opened here is explicitly closed (either by
 * its own "close" event or by the fixed-duration timeout that ends the run),
 * and the process exits on its own — no lingering handles, no --forceExit.
 */
import { createConnection, type Socket } from "node:net";

const REALTIME_URL = process.env.REALTIME_URL ?? "http://localhost:4001";
const COUNT = Math.max(1, Number(process.env.TUNNEL_CANARY_COUNT ?? "5"));
const DURATION_MS = Math.max(1, Number(process.env.TUNNEL_CANARY_DURATION_SEC ?? "120")) * 1000;

const { hostname, port } = new URL(REALTIME_URL);
const connectPort = port ? Number(port) : 80;

interface Canary {
  id: number;
  socket: Socket;
  closedAtMs: number | null;
  closeReason: string | null;
}

function openCanary(id: number, startedAt: number): Promise<Canary> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: hostname, port: connectPort });
    const canary: Canary = { id, socket, closedAtMs: null, closeReason: null };

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`canary ${id} failed to connect within 10s`));
    }, 10_000);

    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(canary);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      if (canary.closedAtMs === null) {
        canary.closedAtMs = performance.now() - startedAt;
        canary.closeReason = `error: ${err.message}`;
      }
    });
    socket.once("close", () => {
      if (canary.closedAtMs === null) {
        canary.closedAtMs = performance.now() - startedAt;
        canary.closeReason ??= "close";
      }
    });
  });
}

async function main(): Promise<void> {
  const startedAt = performance.now();
  console.log(`  opening ${COUNT} raw TCP canaries to ${hostname}:${connectPort}, holding for ${DURATION_MS / 1000}s, no application traffic...`);

  const canaries: Canary[] = [];
  for (let i = 0; i < COUNT; i++) {
    try {
      canaries.push(await openCanary(i, startedAt));
    } catch (err) {
      console.error(`  canary ${i}:`, (err as Error).message);
    }
  }
  console.log(`  ${canaries.length}/${COUNT} canaries connected.`);

  await new Promise((resolve) => setTimeout(resolve, DURATION_MS));

  // Explicit cleanup for anything still open — no lingering handles.
  for (const c of canaries) {
    if (!c.socket.destroyed) c.socket.destroy();
  }

  const closed = canaries.filter((c) => c.closedAtMs !== null);
  const survived = canaries.length - closed.length;

  console.log(`  survived full ${DURATION_MS / 1000}s: ${survived}/${canaries.length}`);
  if (closed.length > 0) {
    const closeTimesSec = closed.map((c) => c.closedAtMs! / 1000);
    const spreadMs = (Math.max(...closeTimesSec) - Math.min(...closeTimesSec)) * 1000;
    console.log(
      `  closed early: ${JSON.stringify(
        closed.map((c) => ({ id: c.id, atSec: Number((c.closedAtMs! / 1000).toFixed(3)), reason: c.closeReason })),
      )}`,
    );
    console.log(
      `  close spread: ${spreadMs.toFixed(1)}ms (first at ${Math.min(...closeTimesSec).toFixed(3)}s, last at ${Math.max(...closeTimesSec).toFixed(3)}s)` +
        (spreadMs < 1000 && closed.length > 1
          ? "  <-- SIMULTANEOUS, with ZERO application traffic: this is the relay, not the server or the load"
          : ""),
    );
  } else {
    console.log("  no application-free explanation available: every canary survived the full duration untouched.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
