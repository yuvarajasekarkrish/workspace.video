/** Read-only diagnostics: how long each Socket.IO emit call takes, and above
 *  all its TAIL. An average of 1-2ms per emit can hide a handful of 50-70ms
 *  operations, so this keeps exact cumulative counters of how many ops took
 *  at least 5/10/20/40/50ms (never sampled, never overflowing) plus a bounded
 *  ring of the individual slow ops with what was happening around them.
 *
 *  Nothing here may disturb the emit path: recording is arithmetic on a
 *  monotonic clock, the recipient/size lookups run only for an op that is
 *  already slow, and every failure is swallowed. */

export const TAIL_THRESHOLDS_MS = [5, 10, 20, 40, 50] as const;

/** "tick": a RoomBroadcaster emit made while RoomManager.tick() is running.
 *  "room": a RoomBroadcaster emit made outside the tick (leave, seat, ...).
 *  "direct": an emit made straight on Socket.IO by a socket handler. */
export type EmitPath = "tick" | "room" | "direct";

export interface TailStat {
  count: number;
  totalMs: number;
  maxMs: number;
  /** atLeast[i] = number of ops that took >= TAIL_THRESHOLDS_MS[i]. */
  atLeast: number[];
}

export interface TailOp {
  /** performance.now() at the start of the emit call. */
  atMs: number;
  durationMs: number;
  event: string;
  path: EmitPath;
  recipients: number | null;
  payloadBytes: number | null;
  /** Emits already made in the current tick before this one (0 outside a tick). */
  emitsInTickSoFar: number;
}

export interface EmitTailSnapshot {
  thresholdsMs: number[];
  overall: TailStat;
  /** Keyed "<path>|<event>". */
  byKey: Record<string, TailStat>;
  /** Only ops >= the first threshold, oldest to newest, newest 200. */
  ops: TailOp[];
}

export function newTailStat(): TailStat {
  return { count: 0, totalMs: 0, maxMs: 0, atLeast: TAIL_THRESHOLDS_MS.map(() => 0) };
}

export function addToTailStat(stat: TailStat, ms: number): void {
  stat.count++;
  stat.totalMs += ms;
  if (ms > stat.maxMs) stat.maxMs = ms;
  for (let i = 0; i < TAIL_THRESHOLDS_MS.length; i++) {
    if (ms >= TAIL_THRESHOLDS_MS[i]!) stat.atLeast[i]!++;
  }
}

export function copyTailStat(stat: TailStat): TailStat {
  return { ...stat, atLeast: [...stat.atLeast] };
}

export class EmitTailRecorder {
  static readonly MAX_OPS = 200;

  private overall = newTailStat();
  private readonly byKey = new Map<string, TailStat>();
  private readonly ops: TailOp[] = [];
  private inTick = false;
  private tickEmitCount = 0;
  private tickEmitMs = 0;

  constructor(private readonly now: () => number = () => performance.now()) {}

  beginTick(): void {
    this.inTick = true;
    this.tickEmitCount = 0;
    this.tickEmitMs = 0;
  }

  /** Emits made this tick and the total time spent inside their emit calls.
   *  `audioEmit phase - emitMs` is what is left for preparing payloads. */
  endTick(): { emitCount: number; emitMs: number } {
    this.inTick = false;
    const result = { emitCount: this.tickEmitCount, emitMs: this.tickEmitMs };
    this.tickEmitCount = 0;
    this.tickEmitMs = 0;
    return result;
  }

  /** Runs `fn` (the emit) and records how long it took. The emit's own
   *  exception, if any, is rethrown unchanged after the timing is recorded. */
  time(
    event: string,
    path: EmitPath,
    fn: () => void,
    detail?: { recipients?: () => number; payload?: unknown },
  ): void {
    const start = this.now();
    try {
      fn();
    } finally {
      this.record(event, path, start, this.now() - start, detail);
    }
  }

  private record(
    event: string,
    path: EmitPath,
    startMs: number,
    durationMs: number,
    detail: { recipients?: () => number; payload?: unknown } | undefined,
  ): void {
    try {
      const effectivePath: EmitPath = path === "room" && this.inTick ? "tick" : path;
      if (effectivePath === "tick") {
        this.tickEmitCount++;
        this.tickEmitMs += durationMs;
      }
      addToTailStat(this.overall, durationMs);
      const key = `${effectivePath}|${event}`;
      let stat = this.byKey.get(key);
      if (!stat) {
        stat = newTailStat();
        this.byKey.set(key, stat);
      }
      addToTailStat(stat, durationMs);

      if (durationMs < TAIL_THRESHOLDS_MS[0]) return;

      let recipients: number | null = null;
      try {
        recipients = detail?.recipients?.() ?? null;
      } catch {
        recipients = null;
      }
      let payloadBytes: number | null = null;
      try {
        if (detail?.payload !== undefined) payloadBytes = JSON.stringify(detail.payload)?.length ?? null;
      } catch {
        payloadBytes = null;
      }
      this.ops.push({
        atMs: startMs,
        durationMs,
        event,
        path: effectivePath,
        recipients,
        payloadBytes,
        emitsInTickSoFar: effectivePath === "tick" ? this.tickEmitCount : 0,
      });
      if (this.ops.length > EmitTailRecorder.MAX_OPS) this.ops.shift();
    } catch {
      // Measurement must never disturb the emit path.
    }
  }

  snapshot(): EmitTailSnapshot {
    const byKey: Record<string, TailStat> = {};
    for (const [key, stat] of this.byKey) byKey[key] = copyTailStat(stat);
    return {
      thresholdsMs: [...TAIL_THRESHOLDS_MS],
      overall: copyTailStat(this.overall),
      byKey,
      ops: [...this.ops],
    };
  }
}
