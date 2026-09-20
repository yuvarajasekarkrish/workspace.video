import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./check-test-report.mjs", import.meta.url));

/** Builds a repo-shaped folder with vitest JSON reports, runs the checker on it, cleans up. */
function run(reports) {
  const root = mkdtempSync(join(tmpdir(), "wv-report-"));
  try {
    for (const [dir, report] of Object.entries(reports)) {
      mkdirSync(join(root, dir), { recursive: true });
      writeFileSync(join(root, dir, "vitest-report.json"), JSON.stringify(report));
    }
    const result = spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
    return { status: result.status, out: result.stdout + result.stderr };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const report = (tests) => ({
  numTotalTests: tests.length,
  numFailedTests: tests.filter((t) => t.status === "failed").length,
  testResults: [{ name: "/repo/src/a.test.ts", assertionResults: tests.map((t) => ({ title: t.title, fullName: t.title, status: t.status ?? "passed", duration: t.ms })) }],
});

test("passes when every package ran tests, and lists the slowest tests with their durations", () => {
  const { status, out } = run({
    "apps/web": report([{ title: "fast", ms: 5 }, { title: "the slow one", ms: 4200 }]),
    "packages/shared": report([{ title: "quick", ms: 1 }]),
  });
  assert.equal(status, 0, out);
  assert.match(out, /apps\/web/);
  assert.match(out, /the slow one/);
  assert.match(out, /4200/);
});

test("fails when a package ran zero tests, and names it", () => {
  const { status, out } = run({ "apps/web": report([{ title: "a", ms: 1 }]), "packages/db": report([]) });
  assert.equal(status, 1);
  assert.match(out, /packages\/db/);
  assert.match(out, /no tests/i);
});

test("fails when no report was written at all, so a silently skipped test step cannot pass", () => {
  const { status, out } = run({});
  assert.equal(status, 1);
  assert.match(out, /no test reports/i);
});

test("still prints the durations when a test failed, and exits 1", () => {
  const { status, out } = run({ "apps/realtime": report([{ title: "passed one", ms: 10 }, { title: "timing test", ms: 5084, status: "failed" }]) });
  assert.equal(status, 1);
  assert.match(out, /timing test/);
  assert.match(out, /5084/);
  assert.match(out, /failed/i);
});

test("ignores reports inside node_modules", () => {
  const { status } = run({ "apps/web": report([{ title: "a", ms: 1 }]), "apps/web/node_modules/pkg": report([]) });
  assert.equal(status, 0);
});
