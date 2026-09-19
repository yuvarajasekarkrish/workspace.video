/** Pure functions over already-collected diagnostics; no I/O, no server
 *  dependency, so the load harness and the offline script share one
 *  implementation. Numbers only: no verdict text. */

export interface StallWindow {
  /** performance.now() at the END of the tick window. */
  atMs: number;
  windowMs: number;
  /** Largest event-loop delay sample seen inside this window (raw histogram
   *  value: includes the ~10ms sampling interval, like the p99 the gate uses). */
  loopMaxMs: number;
  tickMs: number;
  emitMs?: number;
}

export interface Span {
  atMs: number;
  durationMs: number;
}

export interface StallGroup {
  windows: number;
  /** Windows containing at least one emit of >= overlapMs. */
  withEmit: number;
  /** Windows containing at least one GC pause of >= overlapMs. */
  withGc: number;
  withBoth: number;
  withNeither: number;
  medianTickMs: number | null;
  medianEmitMs: number | null;
}

export interface StallSummary {
  stallMs: number;
  overlapMs: number;
  stalled: StallGroup;
  /** Same counts over the windows that did NOT stall: the chance baseline. */
  control: StallGroup;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function overlaps(window: StallWindow, span: Span): boolean {
  const windowStart = window.atMs - window.windowMs;
  return span.atMs <= window.atMs && span.atMs + span.durationMs >= windowStart;
}

function summarizeGroup(windows: StallWindow[], emits: Span[], gcs: Span[]): StallGroup {
  let withEmit = 0;
  let withGc = 0;
  let withBoth = 0;
  let withNeither = 0;
  for (const w of windows) {
    const e = emits.some((s) => overlaps(w, s));
    const g = gcs.some((s) => overlaps(w, s));
    if (e) withEmit++;
    if (g) withGc++;
    if (e && g) withBoth++;
    if (!e && !g) withNeither++;
  }
  return {
    windows: windows.length,
    withEmit,
    withGc,
    withBoth,
    withNeither,
    medianTickMs: median(windows.map((w) => w.tickMs)),
    medianEmitMs: median(windows.filter((w) => w.emitMs !== undefined).map((w) => w.emitMs!)),
  };
}

export function summarizeStalls(
  windows: StallWindow[],
  tailOps: Span[],
  gcPauses: Span[],
  options: { stallMs?: number; overlapMs?: number } = {},
): StallSummary {
  const stallMs = options.stallMs ?? 50;
  const overlapMs = options.overlapMs ?? 20;
  const emits = tailOps.filter((s) => s.durationMs >= overlapMs);
  const gcs = gcPauses.filter((s) => s.durationMs >= overlapMs);
  return {
    stallMs,
    overlapMs,
    stalled: summarizeGroup(
      windows.filter((w) => w.loopMaxMs >= stallMs),
      emits,
      gcs,
    ),
    control: summarizeGroup(
      windows.filter((w) => w.loopMaxMs < stallMs),
      emits,
      gcs,
    ),
  };
}
