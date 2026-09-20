import { EmitTailRecorder, type EmitTailSnapshot, type TailStat } from "./emitTailRecorder";
import { GcRecorder, type GcSnapshot } from "./gcRecorder";
import { iterationMs, summarizeStallsCovered, type StallGroup, type StallWindow } from "./stallSummary";

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;
}

/** Formats the Phase 17 diagnostics as plain lines, shared by the load harness
 *  and the offline analysis script. Numbers only: no verdict text, so the
 *  reading of them stays a human decision written down next to the evidence. */

const f = (x: number | null | undefined, digits = 1): string => (x == null ? "n/a" : x.toFixed(digits));

function statLine(label: string, stat: TailStat, thresholds: number[]): string {
  const buckets = thresholds.map((t, i) => `>=${t}: ${stat.atLeast[i]}`).join(" · ");
  return `    ${label.padEnd(34)} n=${stat.count} total ${f(stat.totalMs)}ms max ${f(stat.maxMs)}ms | ${buckets}`;
}

function groupLine(label: string, g: StallGroup): string {
  return (
    `    ${label.padEnd(30)} windows ${g.windows} · containing emit>=20ms ${g.withEmit} · GC>=20ms ${g.withGc}` +
    ` · both ${g.withBoth} · neither ${g.withNeither} · median tickMs ${f(g.medianTickMs)} · median emitMs ${f(g.medianEmitMs, 2)}`
  );
}

export function formatStallReport(input: {
  windows: StallWindow[];
  emitTail?: EmitTailSnapshot | null;
  gc?: GcSnapshot | null;
}): string[] {
  const lines: string[] = [];
  const { windows, emitTail, gc } = input;

  const measured = windows.filter((w) => w.postTickMs != null);
  if (measured.length > 0) {
    const burst = measured.map((w) => w.postTickMs!);
    const iteration = measured.map(iterationMs);
    const q = (values: number[]) =>
      `p50 ${f(percentile(values, 0.5))} · p90 ${f(percentile(values, 0.9))} · p99 ${f(percentile(values, 0.99))} · max ${f(percentile(values, 1))}`;
    lines.push(`  post-tick burst (delay from tick end to the loop's check phase), ${measured.length} windows, ms: ${q(burst)}`);
    lines.push(
      `  tick + burst (what a loop-delay sample across the tick would see, minus its own ~10ms interval), ms: ${q(iteration)}` +
        ` · windows >= 50ms: ${iteration.filter((v) => v >= 50).length}/${iteration.length}`,
    );
  }

  if (emitTail) {
    lines.push("  emit tail (every emit call timed; counts are exact, not sampled):");
    lines.push(statLine("all emits", emitTail.overall, emitTail.thresholdsMs));
    const slow = Object.entries(emitTail.byKey)
      .filter(([, s]) => s.atLeast[0]! > 0)
      .sort((a, b) => b[1].maxMs - a[1].maxMs)
      .slice(0, 8);
    for (const [key, stat] of slow) lines.push(statLine(key, stat, emitTail.thresholdsMs));
    const top = [...emitTail.ops].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    for (const op of top) {
      lines.push(
        `    slowest: ${f(op.durationMs)}ms ${op.path}|${op.event} recipients=${op.recipients ?? "n/a"} bytes=${op.payloadBytes ?? "n/a"} emitsInTickSoFar=${op.emitsInTickSoFar} at ${f(op.atMs, 0)}ms`,
      );
    }
  }

  if (gc) {
    lines.push(`  GC pauses (observer supported: ${gc.supported ? "yes" : "no"}):`);
    lines.push(statLine("all GC pauses", gc.overall, gc.thresholdsMs));
    for (const [kind, stat] of Object.entries(gc.byKind)) lines.push(statLine(`  ${kind}`, stat, gc.thresholdsMs));
    const top = [...gc.pauses].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
    for (const p of top) lines.push(`    longest: ${f(p.durationMs)}ms ${p.kind} at ${f(p.atMs, 0)}ms`);
  }

  if (windows.length > 0 && emitTail && gc) {
    const s = summarizeStallsCovered(
      windows,
      emitTail.ops,
      gc.pauses,
      { ops: EmitTailRecorder.MAX_OPS, pauses: GcRecorder.MAX_PAUSES },
    );
    lines.push(
      `  long-window overlap (long = tick + post-tick burst >= ${s.stallMs}ms; ` +
        `analyzed ${s.analyzedWindows}/${s.totalWindows} windows${s.truncated ? ", earlier ones dropped: a full ring no longer covers them" : ""}):`,
    );
    lines.push(groupLine(`long (tick+burst >= ${s.stallMs})`, s.stalled));
    lines.push(groupLine(`control (tick+burst < ${s.stallMs})`, s.control));
  }
  return lines;
}
