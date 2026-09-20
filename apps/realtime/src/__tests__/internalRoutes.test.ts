import { describe, it, expect, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerInternalGuard, registerResolveRoomRoute } from "../internalRoutes.js";

const TOKEN = "a-long-random-metrics-token-0123456789abcdef";
const METRICS = { cpu: 12, rooms: 3 };

/** A server shaped like the real one: the guard first, then the routes. */
async function build(production: boolean): Promise<FastifyInstance> {
  const app = Fastify();
  registerInternalGuard(app, { production, metricsToken: TOKEN });
  app.get("/health", async () => ({ ok: true }));
  app.get("/internal/metrics", async () => METRICS);
  registerResolveRoomRoute(app, { production, resolve: async (roomId) => ({ roomId, url: "http://10.0.0.5:4001" }) });
  app.post("/internal/load-harness/provision", async () => ({ provisioned: true }));
  await app.ready();
  return app;
}

const apps: FastifyInstance[] = [];
async function server(production: boolean) {
  const app = await build(production);
  apps.push(app);
  return app;
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map((a) => a.close()));
});

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

describe("in production", () => {
  it("serves /health with no token", async () => {
    const app = await server(true);
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });

  describe("/internal/metrics", () => {
    it("refuses a request with no token (401) and does not run the handler", async () => {
      const app = await server(true);
      const res = await app.inject({ url: "/internal/metrics" });
      expect(res.statusCode).toBe(401);
      expect(res.body).not.toContain("cpu");
    });

    it("refuses a wrong token, a token of another length, and a non-Bearer scheme", async () => {
      const app = await server(true);
      for (const headers of [bearer("wrong"), bearer(TOKEN + "x"), bearer(TOKEN.slice(0, -1)), { authorization: `Basic ${TOKEN}` }, { authorization: TOKEN }]) {
        expect((await app.inject({ url: "/internal/metrics", headers })).statusCode, JSON.stringify(headers)).toBe(401);
      }
    });

    it("does not accept the token in the query string", async () => {
      const app = await server(true);
      expect((await app.inject({ url: `/internal/metrics?token=${TOKEN}` })).statusCode).toBe(401);
    });

    it("serves the metrics for the right token", async () => {
      const app = await server(true);
      const res = await app.inject({ url: "/internal/metrics", headers: bearer(TOKEN) });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(METRICS);
    });

    it("accepts the token when a query string is present, and the scheme in any letter case", async () => {
      const app = await server(true);
      expect((await app.inject({ url: "/internal/metrics?x=1", headers: { authorization: `bearer ${TOKEN}` } })).statusCode).toBe(200);
    });
  });

  describe("everything else under /internal is denied by default, even with the token", () => {
    it.each(["/internal/resolve-room/room1", "/internal/load-harness/provision", "/internal/anything-new", "/internal", "/internal/"])(
      "%s -> 404",
      async (url) => {
        const app = await server(true);
        const res = await app.inject({ method: url.includes("provision") ? "POST" : "GET", url, headers: bearer(TOKEN) });
        expect(res.statusCode).toBe(404);
      },
    );
  });

  describe("other spellings of the same path never reach the data without the token", () => {
    it.each(["//internal/metrics", "/INTERNAL/metrics", "/Internal/Metrics", "/%69nternal/metrics", "/internal/metrics/", "/internal//metrics", "/internal/%6detrics", "/internal/./metrics"])(
      "%s",
      async (url) => {
        const app = await server(true);
        const res = await app.inject({ url });
        expect(res.statusCode, url).not.toBe(200);
        expect(res.body).not.toContain("cpu");
      },
    );
  });

  it("does not register /internal/resolve-room at all (404 without a guard involved)", async () => {
    const bare = Fastify();
    const registered = registerResolveRoomRoute(bare, { production: true, resolve: async () => ({}) });
    await bare.ready();
    expect(registered).toBe(false);
    expect((await bare.inject({ url: "/internal/resolve-room/room1" })).statusCode).toBe(404);
    await bare.close();
  });
});

describe("outside production (development and the load harness keep working with no token)", () => {
  it("serves /internal/metrics with no token", async () => {
    const app = await server(false);
    expect((await app.inject({ url: "/internal/metrics" })).json()).toEqual(METRICS);
  });

  it("serves /internal/resolve-room with no token", async () => {
    const app = await server(false);
    const res = await app.inject({ url: "/internal/resolve-room/room1" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ roomId: "room1", url: "http://10.0.0.5:4001" });
  });

  it("registers the resolve-room route and reports it", async () => {
    const app = Fastify();
    expect(registerResolveRoomRoute(app, { production: false, resolve: async () => ({}) })).toBe(true);
    await app.close();
  });

  it("answers 503 with the error message when resolving fails", async () => {
    const app = Fastify();
    registerResolveRoomRoute(app, {
      production: false,
      resolve: async () => {
        throw new Error("no live instances");
      },
    });
    const res = await app.inject({ url: "/internal/resolve-room/room1" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: "no live instances" });
    await app.close();
  });
});
