// @vitest-environment node
import { describe, it, expect, afterEach, vi } from "vitest";
import { REAL_ENV, restoreEnv, setEnv } from "./helpers/testEnv";

// The production settings checks live in env.ts, which is otherwise only loaded when
// a page or route is first requested. `next start` with no settings therefore came
// up and served (found by the image check in CI, which hung). register() runs once
// at server start, so importing env there makes the server refuse to start instead.

const ALL_UNSET = Object.fromEntries(Object.keys(REAL_ENV).map((k) => [k, undefined]));

afterEach(() => {
  restoreEnv();
  vi.unstubAllEnvs();
});

async function register() {
  vi.resetModules();
  return (await import("../../instrumentation")).register;
}

describe("web server start-up (instrumentation register)", () => {
  it("refuses to start in production when settings are missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    setEnv(ALL_UNSET);
    await expect((await register())()).rejects.toThrow("Refusing to start in production");
  });

  it("starts in production when the settings are real", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    setEnv(REAL_ENV);
    await expect((await register())()).resolves.toBeUndefined();
  });

  it("does not check anything outside the Node runtime", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_RUNTIME", "edge");
    setEnv(ALL_UNSET);
    await expect((await register())()).resolves.toBeUndefined();
  });
});
