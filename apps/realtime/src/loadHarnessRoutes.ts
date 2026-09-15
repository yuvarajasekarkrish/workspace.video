import type { FastifyInstance } from "fastify";
import {
  provisionLoadHarnessWorkspace,
  teardownLoadHarnessWorkspace,
  type LoadHarnessWorkspace,
} from "./loadHarnessFixtures";

const MAX_N = 1000;

export interface LoadHarnessFixtureDeps {
  provision(n: number): Promise<LoadHarnessWorkspace>;
  teardown(workspaceId: string, userIds: string[]): Promise<void>;
}

const defaultDeps: LoadHarnessFixtureDeps = {
  provision: provisionLoadHarnessWorkspace,
  teardown: teardownLoadHarnessWorkspace,
};

/** Double guard, same as server.ts's loadHarnessLimitOverride: these routes
 *  write to the database without user auth, so they must never exist in
 *  production even if the flag is set there by mistake. */
export function loadHarnessRoutesEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV !== "production" && env.LOAD_HARNESS_ENABLED === "1";
}

/** Registers the provision/teardown routes only when enabled; returns whether
 *  it did. When not enabled the routes don't exist at all (404). */
export function maybeRegisterLoadHarnessRoutes(
  app: FastifyInstance,
  env: NodeJS.ProcessEnv,
  deps: LoadHarnessFixtureDeps = defaultDeps,
): boolean {
  if (!loadHarnessRoutesEnabled(env)) return false;

  app.post("/internal/load-harness/provision", async (req, reply) => {
    const n = (req.body as { n?: unknown } | undefined)?.n;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_N) {
      reply.code(400);
      return { error: `n must be an integer between 1 and ${MAX_N}` };
    }
    return deps.provision(n);
  });

  app.post("/internal/load-harness/teardown", async (req, reply) => {
    const body = req.body as { workspaceId?: unknown; userIds?: unknown } | undefined;
    const workspaceId = body?.workspaceId;
    const userIds = body?.userIds;
    if (typeof workspaceId !== "string" || !Array.isArray(userIds) || !userIds.every((id) => typeof id === "string")) {
      reply.code(400);
      return { error: "workspaceId (string) and userIds (string[]) are required" };
    }
    await deps.teardown(workspaceId, userIds);
    return { ok: true };
  });

  return true;
}
