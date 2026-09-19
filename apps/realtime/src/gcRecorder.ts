import { PerformanceObserver, constants } from "node:perf_hooks";
import { TAIL_THRESHOLDS_MS, addToTailStat, copyTailStat, newTailStat, type TailStat } from "./emitTailRecorder";

/** Read-only diagnostics: V8 garbage-collection pauses, with the same tail
 *  buckets as the emit recorder and start times on the same performance.now()
 *  clock, so a pause can be lined up against an event-loop stall. */

export type GcKind = "major" | "minor" | "incremental" | "weakcb" | "unknown";

export interface GcPause {
  /** Start of the pause, on the performance.now() clock. */
  atMs: number;
  durationMs: number;
  kind: GcKind;
}

export interface GcSnapshot {
  /** False when the runtime could not observe GC entries at all. */
  supported: boolean;
  thresholdsMs: number[];
  overall: TailStat;
  byKind: Record<string, TailStat>;
  /** Pauses >= the first threshold, oldest to newest, newest 100. */
  pauses: GcPause[];
}

interface GcEntryLike {
  startTime: number;
  duration: number;
  detail?: { kind?: number } | null;
  kind?: number;
}

const KIND_BY_FLAG = new Map<number, GcKind>([
  [constants.NODE_PERFORMANCE_GC_MAJOR, "major"],
  [constants.NODE_PERFORMANCE_GC_MINOR, "minor"],
  [constants.NODE_PERFORMANCE_GC_INCREMENTAL, "incremental"],
  [constants.NODE_PERFORMANCE_GC_WEAKCB, "weakcb"],
]);

export class GcRecorder {
  static readonly MAX_PAUSES = 100;

  supported = false;
  private overall = newTailStat();
  private readonly byKind = new Map<GcKind, TailStat>();
  private readonly pauses: GcPause[] = [];

  record(entry: GcEntryLike): void {
    try {
      const flag = entry.detail?.kind ?? entry.kind;
      const kind = (flag !== undefined ? KIND_BY_FLAG.get(flag) : undefined) ?? "unknown";
      addToTailStat(this.overall, entry.duration);
      let stat = this.byKind.get(kind);
      if (!stat) {
        stat = newTailStat();
        this.byKind.set(kind, stat);
      }
      addToTailStat(stat, entry.duration);
      if (entry.duration < TAIL_THRESHOLDS_MS[0]) return;
      this.pauses.push({ atMs: entry.startTime, durationMs: entry.duration, kind });
      if (this.pauses.length > GcRecorder.MAX_PAUSES) this.pauses.shift();
    } catch {
      // Diagnostics must never throw into the observer callback.
    }
  }

  snapshot(): GcSnapshot {
    const byKind: Record<string, TailStat> = {};
    for (const [kind, stat] of this.byKind) byKind[kind] = copyTailStat(stat);
    return {
      supported: this.supported,
      thresholdsMs: [...TAIL_THRESHOLDS_MS],
      overall: copyTailStat(this.overall),
      byKind,
      pauses: [...this.pauses],
    };
  }
}

interface ObserverLike {
  observe(options: { entryTypes: string[] }): void;
  disconnect(): void;
}
type ObserverCtor = new (cb: (list: { getEntries(): GcEntryLike[] }) => void) => ObserverLike;

/** Starts feeding `recorder` from the runtime's GC entries. Returns a stop
 *  function that disconnects the observer; call it at shutdown so nothing
 *  started is left running. A runtime that cannot observe GC leaves
 *  `recorder.supported` false and returns a no-op. */
export function startGcObserver(
  recorder: GcRecorder,
  Observer: ObserverCtor = PerformanceObserver as unknown as ObserverCtor,
): () => void {
  try {
    const observer = new Observer((list) => {
      for (const entry of list.getEntries()) recorder.record(entry);
    });
    observer.observe({ entryTypes: ["gc"] });
    recorder.supported = true;
    return () => observer.disconnect();
  } catch {
    recorder.supported = false;
    return () => {};
  }
}
