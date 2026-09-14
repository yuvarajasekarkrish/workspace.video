import Fastify from "fastify";
import { Server as SocketIOServer } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";
import { resolveRoomEndpoint } from "@cosmos/realtime-core";
import {
  ClientEvents,
  ServerEvents,
  JoinRoomEventSchema,
  MoveEventSchema,
  type PeersSnapshotEvent,
} from "@cosmos/shared";
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

const roomManager = new RoomManager(broadcasterFromSocketServer(io), roomLease, instanceId);

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
    await socket.join(roomId);

    roomManager.addPeer(roomId, {
      userId: user.userId,
      name: user.email, // placeholder until profile data is wired up in phase 2
      avatarUrl: null,
      socketId: socket.id,
      // TODO(phase 7): use the room's configured spawn point instead of a
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

  socket.on("disconnect", () => {
    const roomId = socket.data.roomId as string | undefined;
    if (roomId) roomManager.removePeer(roomId, user.userId);
  });
});

startHeartbeat();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    roomManager.disposeAll(); // clear every room's tick/lease-refresh interval before exiting
    await stopHeartbeat();
    await app.close();
    process.exit(0);
  });
}

app.log.info(`realtime instance ${instanceId} listening on :${env.port}`);
