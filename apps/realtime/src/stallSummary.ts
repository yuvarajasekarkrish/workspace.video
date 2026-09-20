/** Pure functions over already-collected diagnostics; no I/O, no server
 *  dependency, so the load harness and the offline script share one
 *  implementation. Numbers only: no verdict text. */

export interface StallWindow {
  /** performance.now() at the END of the tick window. */
  atMs: number;
  windowMs: number;
  tickMs: number;
  /** Time from the end of the tick until the loop reached its check phase:
   *  the poll-phase work that follows the tick. null/absent = not measured. */
  postTickMs?: number | null;
  emitMs?: number;
}

/** How long the loop was away from its timers around one tick: the tick itself
 *  plus the burst of I/O work processed right after it. This is what a
 *  loop-delay sample taken across the tick would have seen (minus its own
 *  ~10ms interval). */
export function iterationMs(w: StallWindow): number {
  return w.tickMs + (w.postTickMs ?? 0);
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

export interface CoveredStallSummary extends StallSummary {
  totalWindows: number;
  /** Windows actually analyzed: those inside the time range every ring covers. */
  analyzedWindows: number;
  /** True when a full ring dropped older entries, so earlier windows were skipped. */
  truncated: boolean;
}

/** The rings keep only the newest N entries, so an op or pause older than the
 *  ring's oldest entry may have existed without being kept. Counting a window
 *  from before that point as "no slow emit" would be wrong, so windows that
 *  start before the coverage of any FULL ring are left out. */
export function summarizeStallsCovered(
  windows: StallWindow[],
  tailOps: Span[],
  gcPauses: Span[],
  ringSizes: { ops: number; pauses: number },
  options: { stallMs?: number; overlapMs?: number } = {},
): CoveredStallSummary {
  const start = Math.max(
    tailOps.length >= ringSizes.ops ? tailOps[0]!.atMs : -Infinity,
    gcPauses.length >= ringSizes.pauses ? gcPauses[0]!.atMs : -Infinity,
  );
  const analyzed = windows.filter((w) => w.atMs - w.windowMs >= start);
  return {
    ...summarizeStalls(analyzed, tailOps, gcPauses, options),
    totalWindows: windows.length,
    analyzedWindows: analyzed.length,
    truncated: analyzed.length < windows.length,
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
      windows.filter((w) => iterationMs(w) >= stallMs),
      emits,
      gcs,
    ),
    control: summarizeGroup(
      windows.filter((w) => iterationMs(w) < stallMs),
      emits,
      gcs,
    ),
  };
}
