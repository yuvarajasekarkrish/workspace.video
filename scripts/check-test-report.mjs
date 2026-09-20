#!/usr/bin/env node
// Reads the vitest JSON reports the CI test step writes (vitest-report.json in
// each package) and does two things:
//
//   1. fails if no report exists, or any package ran ZERO tests, so a test step
//      that silently ran nothing can never pass;
//   2. prints every package's totals and its slowest tests with their durations,
//      pass or fail. When a timing-sensitive test fails, the durations are the
//      evidence to inspect before any timeout or retry is touched: nothing is
//      retried or loosened automatically.
//
//   node scripts/check-test-report.mjs [rootDir]        (default: the current directory)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.argv[2] ?? process.cwd();
const SLOWEST = 8;

function findReports(dir, found = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) findReports(path, found);
    else if (name === "vitest-report.json") found.push(path);
  }
  return found;
}

const reports = findReports(root).sort();
if (reports.length === 0) {
  console.error("No test reports found: the test step did not write any vitest-report.json, so nothing was verified.");
  process.exit(1);
}

let problems = 0;
for (const path of reports) {
  const label = relative(root, join(path, "..")).replaceAll("\\", "/") || ".";
  const report = JSON.parse(readFileSync(path, "utf8"));
  const total = report.numTotalTests ?? 0;
  const failed = report.numFailedTests ?? 0;

  console.log(`\n${label}: ${total} tests, ${failed} failed`);
  if (total === 0) {
    console.error(`  ${label} ran no tests. An empty suite must not pass.`);
    problems++;
  }
  if (failed > 0) problems++;

  const all = (report.testResults ?? []).flatMap((file) =>
    (file.assertionResults ?? []).map((t) => ({ name: t.fullName ?? t.title, ms: Math.round(t.duration ?? 0), status: t.status, file: file.name })),
  );
  for (const t of all.sort((a, b) => b.ms - a.ms).slice(0, SLOWEST)) {
    console.log(`  ${String(t.ms).padStart(6)} ms  ${t.status === "failed" ? "FAILED " : ""}${t.name}`);
  }
}

process.exit(problems > 0 ? 1 : 0);
