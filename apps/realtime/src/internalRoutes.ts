import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply } from "fastify";

/**
 * Production rules for the realtime server's /internal pages. They were built
 * for development and load testing and had no login: one lists the addresses of
 * live instances, the other reports load and memory and RESETS its own
 * "since last read" counters on every read, so anyone polling it corrupts the
 * numbers the operator relies on.
 *
 * In production this is default-deny for everything under /internal:
 *   - /internal/metrics answers only with `Authorization: Bearer <token>`
 *   - every other /internal path is a 404, whatever token is sent
 * Outside production nothing changes, so development and the load harness need no token.
 *
 * This is one of two layers. The web proxy must also forward only /socket.io
 * and /health (see the deploy config), so a mistake in either layer alone does
 * not expose these pages.
 */
export interface InternalGuardOptions {
  production: boolean;
  metricsToken: string;
}

/** Lower-cased, percent-decoded, slash-collapsed path, so /INTERNAL, //internal
 *  and /%69nternal are all recognised as /internal whatever the router does with them. */
function normalisedPath(url: string): string {
  const raw = url.split("?")[0] ?? "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // an undecodable path is treated as written; the checks below still apply
  }
  return decoded.toLowerCase().replace(/\/{2,}/g, "/");
}

/** Constant-time comparison that does not leak the token's length. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const match = /^bearer (.+)$/i.exec(header ?? "");
  if (!match) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(match[1]!), digest(token));
}

const deny = (reply: FastifyReply, status: 401 | 404) =>
  status === 401
    ? reply.code(401).header("www-authenticate", "Bearer").send({ error: "unauthorized" })
    : reply.code(404).send({ error: "Not found" });

/** Must be called before the routes are registered: Fastify applies a hook only to routes added after it. */
export function registerInternalGuard(app: FastifyInstance, options: InternalGuardOptions): void {
  if (!options.production) return;

  app.addHook("onRequest", async (request, reply) => {
    const path = normalisedPath(request.url);
    if (path !== "/internal" && !path.startsWith("/internal/")) return;

    if (path === "/internal/metrics" && tokenMatches(request.headers.authorization, options.metricsToken)) return;
    return deny(reply, path === "/internal/metrics" ? 401 : 404);
  });
}

export interface ResolveRoomOptions {
  production: boolean;
  resolve(roomId: string): Promise<unknown>;
}

/** Registers /internal/resolve-room/:roomId outside production only, and returns
 *  whether it did. In production the route does not exist at all: the web app
 *  resolves rooms directly, so nothing calls it. */
export function registerResolveRoomRoute(app: FastifyInstance, options: ResolveRoomOptions): boolean {
  if (options.production) return false;

  app.get<{ Params: { roomId: string } }>("/internal/resolve-room/:roomId", async (req, reply) => {
    try {
      return await options.resolve(req.params.roomId);
    } catch (err) {
      reply.code(503);
      return { error: (err as Error).message };
    }
  });
  return true;
}
