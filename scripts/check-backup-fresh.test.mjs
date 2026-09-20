import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { checkFresh } from "./check-backup-fresh.mjs";

const H = 3_600_000;
const NOW = 1_000_000 * H;

test("fresh backup passes", () => {
  assert.equal(checkFresh([{ name: "a.dump", mtimeMs: NOW - 2 * H, size: 10 }], NOW, 26).ok, true);
});
test("exactly at the limit passes, just past it fails", () => {
  assert.equal(checkFresh([{ name: "a", mtimeMs: NOW - 26 * H, size: 1 }], NOW, 26).ok, true);
  assert.equal(checkFresh([{ name: "a", mtimeMs: NOW - 26.1 * H, size: 1 }], NOW, 26).ok, false);
});
test("uses the newest file, not the oldest", () => {
  const files = [{ name: "old", mtimeMs: NOW - 100 * H, size: 1 }, { name: "new", mtimeMs: NOW - H, size: 1 }];
  assert.equal(checkFresh(files, NOW, 26).ok, true);
});
test("no files fails", () => {
  const r = checkFresh([], NOW, 26);
  assert.equal(r.ok, false);
  assert.match(r.message, /no backup files/);
});
test("an empty backup file does not count", () => {
  assert.equal(checkFresh([{ name: "empty", mtimeMs: NOW, size: 0 }], NOW, 26).ok, false);
});

test("command line: exit codes for fresh, stale, missing dir and bad usage", () => {
  const dir = mkdtempSync(join(tmpdir(), "bk-"));
  try {
    const run = (...a) => spawnSync(process.execPath, ["scripts/check-backup-fresh.mjs", ...a], { encoding: "utf8" });
    const f = join(dir, "pre-abc-1.dump");
    writeFileSync(f, "data");
    assert.equal(run(dir).status, 0);
    const old = new Date(Date.now() - 30 * H);
    utimesSync(f, old, old);
    const stale = run(dir);
    assert.equal(stale.status, 1);
    assert.match(stale.stdout, /^STALE/);
    assert.equal(run(join(dir, "nope")).status, 1);
    assert.equal(run().status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
