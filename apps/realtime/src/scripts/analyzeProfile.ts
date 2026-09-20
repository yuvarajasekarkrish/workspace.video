/**
 * Offline summary of V8 .cpuprofile files from `node --cpu-prof`. Prints, per
 * profile that contains the room tick, main-thread busy time inside vs outside
 * the tick, by library, and the top self-time functions outside the tick.
 * Read-only.
 *
 *   pnpm --filter @cosmos/realtime run analyze-profile -- prof/
 *   pnpm --filter @cosmos/realtime run analyze-profile -- prof/CPU.x.cpuprofile
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { summarizeProfile, type Bucket, type CpuProfile } from "../profileSummary";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: analyze-profile <file.cpuprofile | directory>");
  process.exit(2);
}
const files = statSync(arg).isDirectory()
  ? readdirSync(arg).filter((f) => f.endsWith(".cpuprofile")).map((f) => join(arg, f))
  : [arg];

const f1 = (x: number) => x.toFixed(1);
const groupLine = (b: Bucket) =>
  Object.entries(b.byGroup)
    .sort((a, c) => c[1] - a[1])
    .map(([g, ms]) => `${g} ${f1(ms)}ms (${b.totalMs > 0 ? ((ms / b.totalMs) * 100).toFixed(0) : 0}%)`)
    .join(" · ");

for (const file of files) {
  const profile = JSON.parse(readFileSync(file, "utf8")) as CpuProfile;
  const s = summarizeProfile(profile);
  console.log(`\n${file}`);
  console.log(`  samples ${profile.samples.length} · busy ${f1(s.insideTick.totalMs + s.outsideTick.totalMs)}ms · idle ${f1(s.idleMs)}ms · contains room tick: ${s.hasTick ? "yes" : "no"}`);
  if (!s.hasTick) continue;
  console.log(`  inside tick   ${f1(s.insideTick.totalMs)}ms: ${groupLine(s.insideTick)}`);
  console.log(`  outside tick  ${f1(s.outsideTick.totalMs)}ms: ${groupLine(s.outsideTick)}`);
  console.log("  top self-time functions OUTSIDE the tick:");
  for (const [name, ms] of Object.entries(s.outsideTick.byFunction).sort((a, c) => c[1] - a[1]).slice(0, 15)) {
    console.log(`    ${f1(ms).padStart(8)}ms  ${name}`);
  }
}
