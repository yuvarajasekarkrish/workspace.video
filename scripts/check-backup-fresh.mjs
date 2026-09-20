#!/usr/bin/env node
// Fails (exit 1) when the newest backup file is older than the allowed age, or when
// there is none. Meant to be run on a schedule (cron or a monitor) so a backup job
// that silently stopped is noticed within a day.
//
//   node scripts/check-backup-fresh.mjs <backup-dir> [max-age-hours=26] [suffix=.dump]
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Pure decision: files are [{name, mtimeMs, size}], now in ms. */
export function checkFresh(files, nowMs, maxAgeHours) {
  const usable = files.filter((f) => f.size > 0);
  if (usable.length === 0) {
    return { ok: false, message: "no backup files found (or all are empty)" };
  }
  const newest = usable.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a));
  const ageHours = (nowMs - newest.mtimeMs) / 3_600_000;
  const rounded = ageHours.toFixed(1);
  if (ageHours > maxAgeHours) {
    return { ok: false, message: `newest backup ${newest.name} is ${rounded}h old (limit ${maxAgeHours}h)` };
  }
  return { ok: true, message: `newest backup ${newest.name} is ${rounded}h old (limit ${maxAgeHours}h)` };
}

export function listBackups(dir, suffix) {
  return readdirSync(dir)
    .filter((n) => n.endsWith(suffix))
    .map((name) => {
      const s = statSync(join(dir, name));
      return { name, mtimeMs: s.mtimeMs, size: s.size };
    });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [dir, hours = "26", suffix = ".dump"] = process.argv.slice(2);
  if (!dir || !(Number(hours) > 0)) {
    console.error("usage: check-backup-fresh.mjs <backup-dir> [max-age-hours] [suffix]");
    process.exit(2);
  }
  let result;
  try {
    result = checkFresh(listBackups(dir, suffix), Date.now(), Number(hours));
  } catch (err) {
    result = { ok: false, message: `cannot read ${dir}: ${err.message}` };
  }
  console.log(`${result.ok ? "OK" : "STALE"}: ${result.message}`);
  process.exit(result.ok ? 0 : 1);
}
