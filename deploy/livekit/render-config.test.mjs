import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderLiveKitConfig, ConfigError } from "./render-config.mjs";

const GOOD = {
  LIVEKIT_API_KEY: "APIprodKey12345",
  LIVEKIT_API_SECRET: "a-real-livekit-secret-0123456789abcdef0123456789",
};

const problemsOf = (env) => {
  try {
    renderLiveKitConfig(env);
  } catch (e) {
    assert.ok(e instanceof ConfigError, `expected ConfigError, got ${e}`);
    return e.problems;
  }
  assert.fail("expected the config to be refused");
};

test("renders a config from real values, without ever writing the development key", () => {
  const yaml = renderLiveKitConfig(GOOD);
  assert.match(yaml, /APIprodKey12345/);
  assert.match(yaml, /port: 7880/);
  assert.match(yaml, /tcp_port: 7881/);
  assert.match(yaml, /port_range_start: 50000/);
  assert.match(yaml, /port_range_end: 60000/);
  assert.doesNotMatch(yaml, /devkey/);
  assert.doesNotMatch(yaml, /127\.0\.0\.1/);
  assert.doesNotMatch(yaml, /change-me/);
});

test("discovers the public address itself unless one is given", () => {
  assert.match(renderLiveKitConfig(GOOD), /use_external_ip: true/);
  assert.doesNotMatch(renderLiveKitConfig(GOOD), /node_ip:/);
});

test("pins the public address when one is given", () => {
  const yaml = renderLiveKitConfig({ ...GOOD, LIVEKIT_NODE_IP: "203.0.113.10" });
  assert.match(yaml, /node_ip: "203\.0\.113\.10"/);
});

test("adds TURN over TLS only when a domain and its certificate files are given", () => {
  assert.doesNotMatch(renderLiveKitConfig(GOOD), /turn:/);
  const yaml = renderLiveKitConfig({
    ...GOOD,
    LIVEKIT_TURN_DOMAIN: "turn.workspace.video",
    LIVEKIT_TURN_CERT_FILE: "/certs/fullchain.pem",
    LIVEKIT_TURN_KEY_FILE: "/certs/privkey.pem",
  });
  assert.match(yaml, /turn:/);
  assert.match(yaml, /enabled: true/);
  assert.match(yaml, /domain: "turn\.workspace\.video"/);
  assert.match(yaml, /tls_port: 5349/);
  assert.match(yaml, /cert_file: "\/certs\/fullchain\.pem"/);
});

test("quotes values, so a secret with YAML-special characters cannot break the file", () => {
  const yaml = renderLiveKitConfig({ ...GOOD, LIVEKIT_API_SECRET: 'x: "y" # z ' + "a".repeat(40) });
  assert.match(yaml, /"x: \\"y\\" # z a+"/);
});

test("refuses a missing key or secret", () => {
  assert.ok(problemsOf({}).some((p) => /LIVEKIT_API_KEY/.test(p)));
  assert.ok(problemsOf({}).some((p) => /LIVEKIT_API_SECRET/.test(p)));
});

test("refuses the public development key and secret", () => {
  assert.ok(problemsOf({ ...GOOD, LIVEKIT_API_KEY: "devkey" }).some((p) => /LIVEKIT_API_KEY.*development/i.test(p)));
  assert.ok(
    problemsOf({ ...GOOD, LIVEKIT_API_SECRET: "dev-livekit-secret-change-me-32chars-min" }).some((p) => /LIVEKIT_API_SECRET.*development/i.test(p)),
  );
});

test("refuses a secret shorter than 32 characters, and a key with spaces", () => {
  assert.ok(problemsOf({ ...GOOD, LIVEKIT_API_SECRET: "short" }).some((p) => /at least 32/.test(p)));
  assert.ok(problemsOf({ ...GOOD, LIVEKIT_API_KEY: "has space" }).some((p) => /LIVEKIT_API_KEY/.test(p)));
});

for (const address of ["127.0.0.1", "localhost", "0.0.0.0", "10.0.0.5", "172.16.0.9", "172.20.0.3", "172.31.255.1", "192.168.1.20", "169.254.1.1", "not-an-ip", "203.0.113.999"]) {
  test(`refuses ${address} as the public address (a browser elsewhere could not reach it)`, () => {
    assert.ok(problemsOf({ ...GOOD, LIVEKIT_NODE_IP: address }).some((p) => /LIVEKIT_NODE_IP/.test(p)), address);
  });
}

test("accepts public addresses next to the private ranges", () => {
  for (const address of ["172.15.0.1", "172.32.0.1", "8.8.8.8", "203.0.113.10"]) {
    assert.doesNotThrow(() => renderLiveKitConfig({ ...GOOD, LIVEKIT_NODE_IP: address }), address);
  }
});

test("refuses a TURN domain without both certificate files", () => {
  assert.ok(problemsOf({ ...GOOD, LIVEKIT_TURN_DOMAIN: "turn.example.com" }).some((p) => /LIVEKIT_TURN_CERT_FILE/.test(p)));
  assert.ok(
    problemsOf({ ...GOOD, LIVEKIT_TURN_DOMAIN: "turn.example.com", LIVEKIT_TURN_CERT_FILE: "/c.pem" }).some((p) => /LIVEKIT_TURN_KEY_FILE/.test(p)),
  );
});

test("lists every problem at once, and never prints a secret value", () => {
  const secret = "s3cret-value-that-is-too-short";
  const problems = problemsOf({ LIVEKIT_API_KEY: "devkey", LIVEKIT_API_SECRET: secret.slice(0, 10), LIVEKIT_NODE_IP: "127.0.0.1" });
  assert.ok(problems.length >= 3);
  assert.ok(problems.every((p) => !p.includes(secret.slice(0, 10))));
});

test("the command prints the config to stdout when the values are good", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./render-config.mjs", import.meta.url))], { env: { ...GOOD, PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /APIprodKey12345/);
  assert.equal(result.stderr, "");
});

test("the command prints nothing to stdout and exits 1 when refused, so no half-made config is ever saved", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./render-config.mjs", import.meta.url))], { env: { LIVEKIT_API_KEY: "devkey", PATH: process.env.PATH }, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Refusing to write the media server config/);
});
