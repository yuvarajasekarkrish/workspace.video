import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./deploy.sh", import.meta.url));
const TAG = "3f2a9c1d";
const PREVIOUS = "9b8c7d6e";

const BASE_ENV = {
  DRY_RUN: "1",
  REGISTRY: "registry.example.com/workspace-video",
  DATABASE_URL: "postgresql://app:strong-password@db.internal:5432/workspace",
  APP_ADDRESS: "staging.workspace.video",
  DEPLOY_DIR: "/srv/workspace-video",
  PREVIOUS_TAG: PREVIOUS,
};

function deploy(args, env = {}) {
  const result = spawnSync("bash", [SCRIPT, ...args], { env: { ...BASE_ENV, ...env, PATH: process.env.PATH }, encoding: "utf8" });
  return { status: result.status, out: result.stdout, err: result.stderr, all: result.stdout + result.stderr };
}

const steps = (out) => [...out.matchAll(/^STEP ([a-z]+):/gm)].map((m) => m[1]);

test("runs preflight, backup, pull, migrate, restart, health, record, in that order", () => {
  const r = deploy(["staging", TAG]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(steps(r.out), ["preflight", "backup", "pull", "migrate", "restart", "health", "record"]);
});

test("always backs up the database before it migrates", () => {
  const order = steps(deploy(["staging", TAG]).out);
  const backup = order.indexOf("backup");
  const migrate = order.indexOf("migrate");
  assert.ok(backup >= 0 && migrate >= 0, `both steps must run, got ${order}`);
  assert.ok(backup < migrate);
});

test("names the exact image tag it deploys, and the tag it would roll back to", () => {
  const r = deploy(["staging", TAG]);
  assert.match(r.out, new RegExp(`workspace-video-web:${TAG}`));
  assert.match(r.out, new RegExp(PREVIOUS));
});

test("stops at the first failing step and does not run the ones after it", () => {
  for (const [failAt, expectedRan] of [
    ["backup", ["preflight", "backup"]],
    ["pull", ["preflight", "backup", "pull"]],
    ["migrate", ["preflight", "backup", "pull", "migrate"]],
    ["health", ["preflight", "backup", "pull", "migrate", "restart", "health"]],
  ]) {
    const r = deploy(["staging", TAG], { DRY_RUN_FAIL_AT: failAt });
    assert.notEqual(r.status, 0, failAt);
    assert.deepEqual(steps(r.out), expectedRan, failAt);
    assert.doesNotMatch(r.out, /STEP record/, failAt);
  }
});

test("after a failed health check it says how to go back, and does not touch the database again", () => {
  const r = deploy(["staging", TAG], { DRY_RUN_FAIL_AT: "health" });
  assert.match(r.all, new RegExp(`--rollback.*${PREVIOUS}|${PREVIOUS}.*--rollback`, "s"));
});

test("rollback redeploys the previous tag without a backup or a migration", () => {
  const r = deploy(["staging", PREVIOUS, "--rollback"]);
  assert.equal(r.status, 0, r.all);
  assert.deepEqual(steps(r.out), ["preflight", "pull", "restart", "health", "record"]);
  assert.match(r.out, new RegExp(`workspace-video-web:${PREVIOUS}`));
});

test("refuses an image tag that is not an immutable commit id (latest, branch names, empty)", () => {
  for (const tag of ["latest", "master", "v1", "", "abc"]) {
    const r = deploy(["staging", tag]);
    assert.notEqual(r.status, 0, JSON.stringify(tag));
    assert.deepEqual(steps(r.out), [], JSON.stringify(tag));
  }
});

test("refuses an unknown environment name", () => {
  assert.notEqual(deploy(["prod", TAG]).status, 0);
  assert.notEqual(deploy([]).status, 0);
});

test("refuses to deploy to production without an explicit confirmation", () => {
  const without = deploy(["production", TAG]);
  assert.notEqual(without.status, 0);
  assert.match(without.all, /CONFIRM=production/);
  assert.deepEqual(steps(without.out), []);
  assert.equal(deploy(["production", TAG], { CONFIRM: "production" }).status, 0);
});

test("refuses when a required setting is missing, before doing anything", () => {
  for (const missing of ["REGISTRY", "DATABASE_URL", "APP_ADDRESS", "DEPLOY_DIR"]) {
    const env = { ...BASE_ENV };
    delete env[missing];
    const result = spawnSync("bash", [SCRIPT, "staging", TAG], { env: { ...env, PATH: process.env.PATH }, encoding: "utf8" });
    assert.notEqual(result.status, 0, missing);
    assert.match(result.stdout + result.stderr, new RegExp(missing), missing);
    assert.deepEqual(steps(result.stdout), [], missing);
  }
});

test("never prints the database password", () => {
  const r = deploy(["staging", TAG]);
  assert.doesNotMatch(r.all, /strong-password/);
});
