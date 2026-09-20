/**
 * Offline summary of V8 .cpuprofile files from `node --cpu-prof`. For each
 * profile that contains the room tick it prints:
 *   - the busy run after each tick (the post-tick burst): how long it lasts,
 *     which libraries the time went to, and the top self-time functions;
 *   - for contrast, the same split over ALL non-tick busy time in the profile
 *     (which also includes startup, joins and reconnects).
 * The optional second argument is the harness's own `post-tick burst` p50 in ms;
 * it is printed next to the profile's run-length median as a cross-check.
 * Read-only.
 *
 *   pnpm --filter @workspace-video/realtime run analyze-profile -- prof/ 23.2
 *   pnpm --filter @workspace-video/realtime run analyze-profile -- prof/CPU.x.cpuprofile --callers=writev
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { summarizeProfile, type Bucket, type CpuProfile } from "../profileSummary";
import { percentile } from "../stallReport";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: analyze-profile <file.cpuprofile | directory> [harness post-tick burst p50 ms]");
  process.exit(2);
}
const harnessP50 = process.argv[3] && !process.argv[3].startsWith("--") ? Number(process.argv[3]) : null;
const callersArg = process.argv.find((a) => a.startsWith("--callers="))?.slice("--callers=".length);
const files = statSync(arg).isDirectory()
  ? readdirSync(arg).filter((f) => f.endsWith(".cpuprofile")).map((f) => join(arg, f))
  : [arg];

const f1 = (x: number | null) => (x == null ? "n/a" : x.toFixed(1));
const groupLine = (b: Bucket) =>
  Object.entries(b.byGroup)
    .sort((a, c) => c[1] - a[1])
    .map(([g, ms]) => `${g} ${f1(ms)}ms (${b.totalMs > 0 ? ((ms / b.totalMs) * 100).toFixed(0) : 0}%)`)
    .join(" · ");
const topFunctions = (b: Bucket, n: number) =>
  Object.entries(b.byFunction).sort((a, c) => c[1] - a[1]).slice(0, n).map(([name, ms]) => `    ${f1(ms).padStart(8)}ms  ${name}`);

for (const file of files) {
  let profile: CpuProfile;
  try {
    profile = JSON.parse(readFileSync(file, "utf8")) as CpuProfile;
  } catch (error) {
    console.log(`\n${file}\n  unreadable: ${(error as Error).message}`);
    continue;
  }
  const s = summarizeProfile(profile, { callersOf: callersArg });
  console.log(`\n${file}`);
  console.log(`  samples ${profile.samples.length} · busy ${f1(s.insideTick.totalMs + s.outsideTick.totalMs)}ms · idle ${f1(s.idleMs)}ms · contains room tick: ${s.hasTick ? "yes" : "no"}`);
  if (!s.hasTick) continue;

  const runs = s.postTick.runMs;
  console.log(
    `  post-tick busy run (tick end to the end of the busy stretch), ${runs.length} ticks, ms: ` +
      `p50 ${f1(percentile(runs, 0.5))} · p90 ${f1(percentile(runs, 0.9))} · p99 ${f1(percentile(runs, 0.99))} · max ${f1(percentile(runs, 1))}` +
      (harnessP50 != null ? `   | harness post-tick burst p50 ${f1(harnessP50)} (cross-check: these two should be close)` : ""),
  );
  console.log(`  inside tick          ${f1(s.insideTick.totalMs)}ms: ${groupLine(s.insideTick)}`);
  console.log(`  post-tick runs only  ${f1(s.postTick.bucket.totalMs)}ms: ${groupLine(s.postTick.bucket)}`);
  console.log(`  all non-tick busy    ${f1(s.outsideTick.totalMs)}ms: ${groupLine(s.outsideTick)}   (includes startup, joins, reconnects)`);
  console.log("  top self-time functions in the post-tick runs:");
  for (const line of topFunctions(s.postTick.bucket, 15)) console.log(line);
  if (callersArg) {
    console.log(`  call chains of ${callersArg} in the post-tick runs (leaf first):`);
    for (const [chain, ms] of Object.entries(s.postTick.callers).sort((a, b) => b[1] - a[1]).slice(0, 6)) {
      console.log(`    ${f1(ms).padStart(8)}ms  ${chain}`);
    }
  }
}
