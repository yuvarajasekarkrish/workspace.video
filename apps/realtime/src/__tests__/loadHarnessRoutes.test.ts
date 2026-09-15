import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { prisma } from "@cosmos/db";
import { loadHarnessRoutesEnabled, maybeRegisterLoadHarnessRoutes } from "../loadHarnessRoutes";
import { provisionLoadHarnessWorkspace, teardownLoadHarnessWorkspace } from "../loadHarnessFixtures";

describe("load-harness routes guard", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("is enabled only with the flag set outside production", () => {
    expect(loadHarnessRoutesEnabled({ LOAD_HARNESS_ENABLED: "1" })).toBe(true);
    expect(loadHarnessRoutesEnabled({ NODE_ENV: "development", LOAD_HARNESS_ENABLED: "1" })).toBe(true);
    expect(loadHarnessRoutesEnabled({})).toBe(false);
    expect(loadHarnessRoutesEnabled({ LOAD_HARNESS_ENABLED: "true" })).toBe(false);
    expect(loadHarnessRoutesEnabled({ NODE_ENV: "production", LOAD_HARNESS_ENABLED: "1" })).toBe(false);
  });

  it.each([
    ["flag missing", {}],
    ["production", { NODE_ENV: "production", LOAD_HARNESS_ENABLED: "1" }],
  ])("returns 404 for both routes when %s", async (_label, env) => {
    app = Fastify();
    const provision = vi.fn();
    const teardown = vi.fn();
    expect(maybeRegisterLoadHarnessRoutes(app, env, { provision, teardown })).toBe(false);

    const p = await app.inject({ method: "POST", url: "/internal/load-harness/provision", payload: { n: 5 } });
    const t = await app.inject({
      method: "POST",
      url: "/internal/load-harness/teardown",
      payload: { workspaceId: "w", userIds: [] },
    });
    expect(p.statusCode).toBe(404);
    expect(t.statusCode).toBe(404);
    expect(provision).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });

  it("validates n and the teardown body when enabled", async () => {
    app = Fastify();
    const provision = vi.fn();
    const teardown = vi.fn();
    maybeRegisterLoadHarnessRoutes(app, { LOAD_HARNESS_ENABLED: "1" }, { provision, teardown });

    for (const n of [0, -1, 1.5, 1001, "10"]) {
      const res = await app.inject({ method: "POST", url: "/internal/load-harness/provision", payload: { n } });
      expect(res.statusCode).toBe(400);
    }
    const badTeardown = await app.inject({
      method: "POST",
      url: "/internal/load-harness/teardown",
      payload: { workspaceId: "w", userIds: [1] },
    });
    expect(badTeardown.statusCode).toBe(400);
    expect(provision).not.toHaveBeenCalled();
    expect(teardown).not.toHaveBeenCalled();
  });
});

describe("load-harness fixtures (real Postgres)", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("provisions n+1 members and a room over HTTP, and teardown removes them", async () => {
    app = Fastify();
    maybeRegisterLoadHarnessRoutes(app, { LOAD_HARNESS_ENABLED: "1" }, {
      provision: provisionLoadHarnessWorkspace,
      teardown: teardownLoadHarnessWorkspace,
    });

    const res = await app.inject({ method: "POST", url: "/internal/load-harness/provision", payload: { n: 3 } });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { workspaceId: string; roomId: string; users: { id: string; email: string }[] };
    const userIds = body.users.map((u) => u.id);

    try {
      expect(body.users).toHaveLength(4);
      const workspace = await prisma.workspace.findUnique({ where: { id: body.workspaceId } });
      expect(workspace?.plan).toBe("enterprise");
      expect(await prisma.workspaceMember.count({ where: { workspaceId: body.workspaceId } })).toBe(4);
      expect(await prisma.room.count({ where: { id: body.roomId } })).toBe(1);

      const td = await app.inject({
        method: "POST",
        url: "/internal/load-harness/teardown",
        payload: { workspaceId: body.workspaceId, userIds },
      });
      expect(td.statusCode).toBe(200);
      expect(await prisma.workspace.count({ where: { id: body.workspaceId } })).toBe(0);
      expect(await prisma.room.count({ where: { id: body.roomId } })).toBe(0);
      expect(await prisma.user.count({ where: { id: { in: userIds } } })).toBe(0);
    } finally {
      await teardownLoadHarnessWorkspace(body.workspaceId, userIds);
    }
  });
});
