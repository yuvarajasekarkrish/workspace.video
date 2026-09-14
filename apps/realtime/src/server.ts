import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { resolveRoomEndpoint } from "@cosmos/realtime-core";
import {
  ClientEvents,
  ServerEvents,
  JoinRoomEventSchema,
  MoveEventSchema,
  ObjectUpsertEventSchema,
  ObjectDeleteEventSchema,
  type PeersSnapshotEvent,
  type ObjectsSnapshotEvent,
} from "@cosmos/shared";
import { loadRoomObjects, upsertObject, deleteObject } from "@cosmos/db";
import { env } from "./env";
import { instanceId, redisPub, redisSub, roomLease, instanceRegistry, startHeartbeat, stopHeartbeat } from "./instance";
import { verifySessionToken, assertRoomMembership } from "./auth";
import { RoomManager, broadcasterFromSocketServer } from "./roomManager";
import { spawnPositionForUser } from "@cosmos/proximity";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true, instanceId }));

// Dev/testing convenience: exercises the exact same resolveRoomEndpoint path
// the Next.js `GET /api/rooms/:id/endpoint` handler will call in apps/web.
// Picks uniformly at random among currently live instances as the candidate.
app.get<{ Params: { roomId: string } }>("/internal/resolve-room/:roomId", async (req, reply) => {
  try {
    const endpoint = await resolveRoomEndpoint(
      req.params.roomId,
      roomLease,
      instanceRegistry,
      async () => {
        const ids = await instanceRegistry.listActiveIds();
        if (ids.length === 0) return null;
        return ids[Math.floor(Math.random() * ids.length)]!;
      },
    );
    return endpoint;
  } catch (err) {
    reply.code(503);
    return { error: (err as Error).message };
  }
});

await app.listen({ port: env.port, host: "0.0.0.0" });

const io = new SocketIOServer(app.server, {
  cors: { origin: "*" }, // tighten to the web app's origin before production
  adapter: createAdapter(redisPub, redisSub),
});

const roomManager = new RoomManager(broadcasterFromSocketServer(io), roomLease, instanceId, 10_000, {
  loadRoomObjects,
  upsertObject,
  deleteObject,
});

io.use((socket, next) => {
  const token = socket.handshake.auth?.token as string | undefined;
  if (!token) return next(new Error("Missing session token."));

  try {
    socket.data.user = verifySessionToken(token, env.authSecret);
    next();
  } catch {
    next(new Error("Invalid session token."));
  }
});

io.on("connection", (socket) => {
  const user = socket.data.user as { userId: string; email: string };

  socket.on(ClientEvents.JoinRoom, async (raw, ack?: (res: unknown) => void) => {
    const parsed = JoinRoomEventSchema.safeParse(raw);
    if (!parsed.success) return ack?.({ error: "Invalid join payload." });

    const { roomId } = parsed.data;

    try {
      await assertRoomMembership(user.userId, roomId);
    } catch (err) {
      return ack?.({ error: (err as Error).message });
    }

    // Claim-or-confirm ownership. This is the guard against a split room: if
    // this instance is not (or is no longer) the authoritative owner, refuse
    // the join and tell the client to re-resolve its endpoint from scratch —
    // never silently serve a second copy of the room's state.
    const owner = await roomLease.claimOrRead(instanceId, roomId);
    if (owner !== instanceId) {
      socket.emit(ServerEvents.OwnerChanged, { roomId });
      return ack?.({ error: "not_owner", roomId });
    }

    roomManager.ensureRoom(roomId);
    // Must complete before any object read/mutation for this room, including
    // this very join's objects:snapshot below — otherwise a joining client
    // could be sent an incomplete (still-loading) object list. Concurrent
    // joins for the same room all await the same in-flight load rather than
    // racing separate ones (see RoomManager.hydrateObjects's docs).
    await roomManager.hydrateObjects(roomId);
    await socket.join(roomId);

    roomManager.addPeer(roomId, {
      userId: user.userId,
      name: user.email, // placeholder until profile data is wired up in phase 2
      avatarUrl: null,
      socketId: socket.id,
      // TODO(phase 8): use the room's configured spawn point instead of a
      // fixed default once Room.config is read here. Deterministic per-user
      // ring offset so multiple avatars don't render exactly on top of each
      // other (see packages/proximity/src/spawn.ts).
      position: spawnPositionForUser(user.userId, { x: 100, y: 100 }),
    });
    socket.data.roomId = roomId;

    // Broadcast to the whole room, not just this socket: existing peers
    // otherwise only ever learn of a newcomer via peers:delta, which carries
    // no name/avatar, so they'd render the newcomer permanently unnamed.
    // This also doubles as the client's clean-resync primitive on reconnect.
    const snapshot: PeersSnapshotEvent = { roomId, peers: roomManager.snapshot(roomId) };
    io.to(roomId).emit(ServerEvents.PeersSnapshot, snapshot);

    // Objects:snapshot goes to the JOINING socket only, unlike peers:snapshot
    // — an existing peer's knowledge of the room's objects doesn't change
    // just because someone else joined (nothing about the peer itself
    // changed), whereas peers:snapshot also doubles as how existing peers
    // learn the newcomer's identity.
    const objectsSnapshot: ObjectsSnapshotEvent = { roomId, objects: roomManager.objectsSnapshot(roomId) };
    socket.emit(ServerEvents.ObjectsSnapshot, objectsSnapshot);

    ack?.({ ok: true });
  });

  socket.on(ClientEvents.Move, (raw) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return;

    const parsed = MoveEventSchema.safeParse(raw);
    if (!parsed.success) return;

    const result = roomManager.applyMove(roomId, user.userId, parsed.data.position);
    if (result && !result.accepted) {
      socket.emit(ServerEvents.MoveCorrection, {
        position: result.correctedPosition,
        reason: result.reason,
      });
    }
  });

  socket.on(ClientEvents.ObjectUpsert, async (raw, ack?: (res: unknown) => void) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return ack?.({ error: "not_in_room" });

    const parsed = ObjectUpsertEventSchema.safeParse(raw);
    if (!parsed.success) return ack?.({ error: "invalid_payload" });

    // Room membership/auth was already proven at join_room; object handlers
    // derive the room from socket.data.roomId (never the payload's roomId)
    // for the same reason the move handler does — a client cannot address
    // another room by simply putting a different id in the payload.
    await roomManager.hydrateObjects(roomId);

    const result = roomManager.applyObjectUpsert(roomId, user.userId, {
      objectId: parsed.data.objectId,
      roomId,
      type: parsed.data.type,
      x: parsed.data.x,
      y: parsed.data.y,
      width: parsed.data.width,
      height: parsed.data.height,
      rotation: parsed.data.rotation,
      z: parsed.data.z,
      data: parsed.data.data,
      baseVersion: parsed.data.baseVersion,
    });

    if (!result) return ack?.({ error: "room_not_found" });

    if (result.accepted) {
      io.to(roomId).emit(ServerEvents.ObjectSync, { object: result.next, accepted: true });
      return ack?.({ ok: true });
    }

    if (result.reason === "not_found") {
      // The object was deleted by someone else since this client last saw
      // it — nothing to sync it TO (ObjectSyncEventSchema requires a
      // non-null object), so just tell the writer it's gone.
      socket.emit(ServerEvents.ObjectRemoved, { objectId: parsed.data.objectId, roomId });
      return ack?.({ error: "not_found" });
    }

    // "room_full" | "id_collision" | "stale_version" — the first has no
    // authoritative object to send (nothing was ever created), the other
    // two do.
    if (result.authoritative) {
      socket.emit(ServerEvents.ObjectSync, { object: result.authoritative, accepted: false });
    }
    ack?.({ error: result.reason });
  });

  socket.on(ClientEvents.ObjectDelete, async (raw, ack?: (res: unknown) => void) => {
    const roomId = socket.data.roomId as string | undefined;
    if (!roomId) return ack?.({ error: "not_in_room" });

    const parsed = ObjectDeleteEventSchema.safeParse(raw);
    if (!parsed.success) return ack?.({ error: "invalid_payload" });

    await roomManager.hydrateObjects(roomId);

    const outcome = roomManager.applyObjectDelete(roomId, user.userId, parsed.data.objectId, parsed.data.baseVersion);
    if (!outcome) return ack?.({ error: "room_not_found" });

    if (outcome.outcome === "deleted" || outcome.outcome === "already_gone") {
      io.to(roomId).emit(ServerEvents.ObjectRemoved, { objectId: parsed.data.objectId, roomId });
      return ack?.({ ok: true });
    }

    // rejected: "stale_version" | "not_creator" — authoritative is always
    // present here since the object must exist for either rejection reason.
    socket.emit(ServerEvents.ObjectSync, { object: outcome.authoritative, accepted: false });
    ack?.({ error: outcome.reason });
  });

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId as string | undefined;
    // Fire-and-forget: removePeer is async since it may flush pending object
    // writes on eviction, but a disconnecting socket has nothing left to
    // wait on the result for. A crash between now and flush completion can
    // still lose at most one debounce window of edits — the same documented
    // limitation as the debounce itself (see objectPersistence.ts).
    if (roomId) void roomManager.removePeer(roomId, user.userId);
  });
});

startHeartbeat();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    // Clears every room's tick/lease-refresh interval and flushes any
    // pending object writes before exiting — awaited so a debounce window
    // in progress at shutdown doesn't silently lose edits.
    await roomManager.disposeAll();
    await stopHeartbeat();
    await app.close();
    process.exit(0);
  });
}

app.log.info(`realtime instance ${instanceId} listening on :${env.port}`);
