import type { RoomBroadcaster } from "./roomManager";

/** Cumulative per-event emit stats. Bytes are sampled (see
 *  `CountingBroadcaster`'s docs), never measured on every emit — so
 *  `sampledBytesSum / sampledCount` is an average payload size, and
 *  multiplying that average by `count` estimates a total. */
export interface EmitEventStats {
  count: number;
  sampledCount: number;
  sampledBytesSum: number;
}

/**
 * Decorates a RoomBroadcaster to count emits per event name and sample
 * payload size — Phase 10 instrumentation to answer "how much of the tick
 * is spent emitting, and how much data does that actually push" with a
 * number instead of a guess. Never changes emit behavior: every call is
 * passed straight through to the wrapped broadcaster unchanged.
 *
 * Bytes are sampled at 1-in-`sampleRate` (default 20) rather than measured
 * on every emit — `JSON.stringify` on every payload would itself add
 * serialization cost to the exact hot path this is trying to measure
 * without disturbing.
 *
 * Counts are cumulative for the process's lifetime; a caller wanting a
 * rate (emits/sec, bytes/sec) is expected to snapshot this at two points in
 * time and divide by the elapsed seconds — see server.ts's /internal/metrics
 * handler, which does exactly that for CPU usage via `process.cpuUsage()`
 * deltas, the same pattern applied here for consistency.
 */
export class CountingBroadcaster implements RoomBroadcaster {
  private readonly stats = new Map<string, EmitEventStats>();
  private globalEmitCounter = 0;

  constructor(
    private readonly inner: RoomBroadcaster,
    private readonly sampleRate = 20,
  ) {}

  to(target: string): { emit(event: string, payload: unknown): void } {
    const innerTarget = this.inner.to(target);
    return {
      emit: (event: string, payload: unknown) => {
        let stat = this.stats.get(event);
        if (!stat) {
          stat = { count: 0, sampledCount: 0, sampledBytesSum: 0 };
          this.stats.set(event, stat);
        }
        stat.count++;
        this.globalEmitCounter++;
        if (this.globalEmitCounter % this.sampleRate === 0) {
          stat.sampledBytesSum += JSON.stringify(payload).length;
          stat.sampledCount++;
        }
        innerTarget.emit(event, payload);
      },
    };
  }

  disconnectSocketsInRoom(roomId: string): void {
    this.inner.disconnectSocketsInRoom(roomId);
  }

  /** A snapshot of every event's cumulative stats, safe to read at any time
   *  without affecting counting (a plain copy, not a reference into the
   *  live maps). */
  snapshot(): Record<string, EmitEventStats> {
    const result: Record<string, EmitEventStats> = {};
    for (const [event, stat] of this.stats) {
      result[event] = { ...stat };
    }
    return result;
  }
}
