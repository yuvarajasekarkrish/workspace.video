import type { Server as SocketIOServer, Socket } from "socket.io";
import type { RoomLease } from "@cosmos/realtime-core";
import {
  ClientEvents,
  ServerEvents,
  JoinRoomEventSchema,
  MoveEventSchema,
  ObjectUpsertEventSchema,
  ObjectDeleteEventSchema,
  SeatClaimEventSchema,
  SeatReleaseEventSchema,
  parseRoomConfig,
  resolveLayout,
  DEFAULT_LAYOUT_ID,
  zoneById,
  tileRectCenter,
  movementConfigForLayout,
  DEFAULT_MOVEMENT_CONFIG,
  type PeersSnapshotEvent,
  type ObjectsSnapshotEvent,
  type SeatsSnapshotEvent,
  type RoomLayout,
  type MovementConfig,
  type ParticipantLimitProvider,
} from "@cosmos/shared";
import { spawnPositionForUser } from "@cosmos/proximity";
import type * as Auth from "./auth";
import type { RoomManager } from "./roomManager";
import type { EmitTailRecorder } from "./emitTailRecorder";

export interface SocketHandlerDeps {
  io: SocketIOServer;
  roomManager: RoomManager;
  roomLease: RoomLease;
  authSecret: string;
  instanceId: string;
  joinDuration: { record(ms: number): void };
  disconnectReasonCounts: Record<string, number>;
  loadHarnessLimitOverride: ParticipantLimitProvider;
  auth: Pick<typeof Auth, "verifySessionToken" | "assertRoomMembership" | "assertWorkspaceMembership">;
  /** Called once per new connection, before its handlers attach — server.ts
   *  uses it for heartbeat sampling; tests leave it unset. */
  onConnection?: (socket: Socket) => void;
  /** Phase 17 diagnostics: times the emits made directly on Socket.IO here,
   *  which never pass through CountingBroadcaster. Read-only; unset in tests
   *  that do not care. */
  emitTail?: EmitTailRecorder;
}

export function registerSocketHandlers(deps: SocketHandlerDeps): void {
  const {
    io,
    roomManager,
    roomLease,
    authSecret,
    instanceId,
    joinDuration,
    disconnectReasonCounts,
    loadHarnessLimitOverride,
    onConnection,
    emitTail,
  } = deps;
  const { verifySessionToken, assertRoomMembership, assertWorkspaceMembership } = deps.auth;

  // Wraps a direct emit so its duration lands in the tail histogram. Behavior
  // is identical with or without the recorder: `emit` runs exactly once.
  const timed = (event: string, recipients: () => number, payload: unknown, emit: () => void): void =>
    emitTail ? emitTail.time(event, "direct", emit, { recipients, payload }) : emit();
  const toOne = () => 1;
  const roomSize = (roomId: string) => () => io.sockets.adapter.rooms.get(roomId)?.size ?? 0;

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token as string | undefined;
    if (!token) return next(new Error("Missing session token."));

    try {
      socket.data.user = verifySessionToken(token, authSecret);
      next();
    } catch {
      next(new Error("Invalid session token."));
    }
  });

  io.on("connection", (socket) => {
    const user = socket.data.user as { userId: string; email: string };
    onConnection?.(socket);

    socket.on(ClientEvents.JoinRoom, async (raw, ack?: (res: unknown) => void) => {
      const joinStartedAt = performance.now();
      const finish = (res: unknown) => {
        joinDuration.record(performance.now() - joinStartedAt);
        return ack?.(res);
      };

      const parsed = JoinRoomEventSchema.safeParse(raw);
      if (!parsed.success) return finish({ error: "Invalid join payload." });

      const { roomId } = parsed.data;

      let workspaceId: string;
      let layout: RoomLayout;
      let movementConfig: MovementConfig;
      let limit: number;

      // Fast path: this instance already owns the room. Every answer below is
      // already known — the lease-refresh timer (roomManager.ts's
      // ensureRoom) is what keeps `isOwnedLocally` true, so a second join
      // doesn't need its own Redis round trip to reconfirm ownership, its own
      // Room lookup to learn workspaceId/layout, or its own participant-limit
      // query; RoomManager cached all three the first time this room was
      // ensured. Only the per-USER membership check can't be skipped or
      // cached — it must be re-verified for every joiner.
      const cached = roomManager.getRoomInfo(roomId);
      if (cached) {
        try {
          await assertWorkspaceMembership(user.userId, cached.workspaceId);
        } catch (err) {
          return finish({ error: (err as Error).message });
        }
        workspaceId = cached.workspaceId;
        layout = cached.layout;
        movementConfig = cached.movementConfig;
        limit = cached.participantLimit;
        // hydrateObjects is a memoized no-op after the room's first join (see
        // its docs) — still awaited so a joiner is never sent an incomplete
        // objects:snapshot, but it resolves an already-settled promise here.
        await roomManager.hydrateObjects(roomId);
      } else {
        // Slow path: first joiner for a room this instance doesn't yet own.
        let roomConfig: unknown;
        try {
          ({ workspaceId, config: roomConfig } = await assertRoomMembership(user.userId, roomId));
        } catch (err) {
          return finish({ error: (err as Error).message });
        }

        // Resolved from Room.config, falling back to the default layout for a
        // missing/unknown id — the identical rule the room page applies
        // client-side, so client and server always agree on floor bounds and
        // the spawn point (see @cosmos/shared's layouts module).
        const { layoutId } = parseRoomConfig(roomConfig);
        layout = resolveLayout(layoutId) ?? resolveLayout(DEFAULT_LAYOUT_ID)!;
        movementConfig = movementConfigForLayout(layout, DEFAULT_MOVEMENT_CONFIG);

        // Claim-or-confirm ownership (Redis) and resolve the participant limit
        // (Postgres) concurrently — independent of each other, both only need
        // workspaceId. Phase 15 Part A: the limit is resolved BEFORE
        // ensureRoom and passed in, rather than defaulting the room to
        // participantLimit: 0 and correcting it afterwards — a concurrent
        // joiner's fast path (see getRoomInfo above) trusts that value the
        // instant the room exists, so a room that briefly existed at limit 0
        // let that joiner be wrongly refused workspace_full. This costs
        // nothing extra: it was already a round trip that had to complete
        // before this join's own admission check.
        let owner: string;
        [owner, limit] = await Promise.all([
          roomLease.claimOrRead(instanceId, roomId),
          // Resolved from Workspace.plan today; a future billing system swaps
          // only this provider (see ParticipantLimitProvider in
          // @cosmos/shared) — the rest of this flow is unaffected.
          loadHarnessLimitOverride.getWorkspaceParticipantLimit(workspaceId),
        ]);
        if (owner !== instanceId) {
          timed(ServerEvents.OwnerChanged, toOne, { roomId }, () => socket.emit(ServerEvents.OwnerChanged, { roomId }));
          return finish({ error: "not_owner", roomId });
        }

        // ensureRoom no-ops while a record for this room still exists, and an
        // emptied room's record lives until its object flush finishes — wait
        // it out so this join gets a fresh room, not the one being deleted.
        await roomManager.awaitEviction(roomId);
        roomManager.ensureRoom(roomId, workspaceId, movementConfig, layout, limit);

        // Must complete before any object read/mutation for this room,
        // including this very join's objects:snapshot below — otherwise a
        // joining client could be sent an incomplete (still-loading) object
        // list. Concurrent joins for the same room all await the same
        // in-flight load rather than racing separate ones (see
        // RoomManager.hydrateObjects's docs).
        await roomManager.hydrateObjects(roomId);
      }

      const spawnZone = zoneById(layout, layout.spawnZoneId)!;

      // admitAndAddPeer checks capacity and inserts the peer in one synchronous
      // call, so two sockets racing for the last slot can't both be admitted.
      // Rejected: do NOT join the socket to the room and do not broadcast
      // anything — nothing about the room's state changes for a refused join.
      const admission = roomManager.admitAndAddPeer(roomId, {
        userId: user.userId,
        name: user.email, // placeholder until profile data is wired up in phase 2
        avatarUrl: null,
        socketId: socket.id,
        // Deterministic per-user ring offset around the layout's spawn zone
        // center, so multiple avatars don't render exactly on top of each
        // other (see packages/proximity/src/spawn.ts). Closes the TODO this
        // used to carry — Room.config is now read above via assertRoomMembership.
        position: spawnPositionForUser(user.userId, tileRectCenter(spawnZone.rect), undefined, movementConfig),
      }, limit);

      if (!admission.admitted) {
        return finish({ error: "workspace_full", limit: admission.limit, active: admission.active });
      }

      await socket.join(roomId);
      socket.data.roomId = roomId;

      // Broadcast to the whole room, not just this socket: existing peers
      // otherwise only ever learn of a newcomer via peers:delta, which carries
      // no name/avatar, so they'd render the newcomer permanently unnamed.
      // This also doubles as the client's clean-resync primitive on reconnect,
      // and (via active/limit) how everyone's occupancy display stays current
      // on the join path — see OccupancyUpdateEventSchema for the leave path.
      const occ = roomManager.occupancy(roomId);
      const snapshot: PeersSnapshotEvent = { roomId, peers: roomManager.snapshot(roomId), ...occ };
      timed(ServerEvents.PeersSnapshot, roomSize(roomId), snapshot, () => io.to(roomId).emit(ServerEvents.PeersSnapshot, snapshot));

      // Objects:snapshot goes to the JOINING socket only, unlike peers:snapshot
      // — an existing peer's knowledge of the room's objects doesn't change
      // just because someone else joined (nothing about the peer itself
      // changed), whereas peers:snapshot also doubles as how existing peers
      // learn the newcomer's identity.
      const objectsSnapshot: ObjectsSnapshotEvent = { roomId, objects: roomManager.objectsSnapshot(roomId) };
      timed(ServerEvents.ObjectsSnapshot, toOne, objectsSnapshot, () => socket.emit(ServerEvents.ObjectsSnapshot, objectsSnapshot));

      // Same joiner-only rule as objects:snapshot, for the same reason: an
      // existing peer's knowledge of who's seated where doesn't change just
      // because someone else joined.
      const seatsSnapshot: SeatsSnapshotEvent = { roomId, occupancy: roomManager.seatsSnapshot(roomId) };
      timed(ServerEvents.SeatsSnapshot, toOne, seatsSnapshot, () => socket.emit(ServerEvents.SeatsSnapshot, seatsSnapshot));

      finish({ ok: true });
    });

    socket.on(ClientEvents.Move, (raw) => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return;

      const parsed = MoveEventSchema.safeParse(raw);
      if (!parsed.success) return;

      // clientTs is passed for diagnostics only — see RoomManager.applyMove.
      const result = roomManager.applyMove(roomId, user.userId, parsed.data.position, parsed.data.clientTs);
      if (result && !result.accepted) {
        const correction = { position: result.correctedPosition, reason: result.reason };
        timed(ServerEvents.MoveCorrection, toOne, correction, () => socket.emit(ServerEvents.MoveCorrection, correction));
      }
    });

    socket.on(ClientEvents.SeatClaim, (raw, ack?: (res: unknown) => void) => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return ack?.({ error: "not_in_room" });

      const parsed = SeatClaimEventSchema.safeParse(raw);
      if (!parsed.success) return ack?.({ error: "invalid_payload" });

      const result = roomManager.claimSeat(roomId, user.userId, parsed.data.seatId);
      if (!result) return ack?.({ error: "room_not_found" });
      if (!result.accepted) return ack?.({ error: result.reason });
      ack?.({ ok: true });
    });

    socket.on(ClientEvents.SeatRelease, (raw, ack?: (res: unknown) => void) => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return ack?.({ error: "not_in_room" });

      // Payload is always {} — parsed only to reject malformed non-object
      // input consistently with every other handler here.
      if (!SeatReleaseEventSchema.safeParse(raw).success) return ack?.({ error: "invalid_payload" });

      roomManager.releaseSeat(roomId, user.userId);
      ack?.({ ok: true });
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
        const sync = { object: result.next, accepted: true };
        timed(ServerEvents.ObjectSync, roomSize(roomId), sync, () => io.to(roomId).emit(ServerEvents.ObjectSync, sync));
        return ack?.({ ok: true });
      }

      if (result.reason === "not_found") {
        // The object was deleted by someone else since this client last saw
        // it — nothing to sync it TO (ObjectSyncEventSchema requires a
        // non-null object), so just tell the writer it's gone.
        const removed = { objectId: parsed.data.objectId, roomId };
        timed(ServerEvents.ObjectRemoved, toOne, removed, () => socket.emit(ServerEvents.ObjectRemoved, removed));
        return ack?.({ error: "not_found" });
      }

      // "room_full" | "id_collision" | "stale_version" — the first has no
      // authoritative object to send (nothing was ever created), the other
      // two do.
      if (result.authoritative) {
        const stale = { object: result.authoritative, accepted: false };
        timed(ServerEvents.ObjectSync, toOne, stale, () => socket.emit(ServerEvents.ObjectSync, stale));
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
        const gone = { objectId: parsed.data.objectId, roomId };
        timed(ServerEvents.ObjectRemoved, roomSize(roomId), gone, () => io.to(roomId).emit(ServerEvents.ObjectRemoved, gone));
        return ack?.({ ok: true });
      }

      // rejected: "stale_version" | "not_creator" — authoritative is always
      // present here since the object must exist for either rejection reason.
      const authoritative = { object: outcome.authoritative, accepted: false };
      timed(ServerEvents.ObjectSync, toOne, authoritative, () => socket.emit(ServerEvents.ObjectSync, authoritative));
      ack?.({ error: outcome.reason });
    });

    socket.on("disconnect", (reason: string) => {
      // Phase 12: the server's disconnect vocabulary is more specific than the
      // client's, and distinguishes the cases the Phase 11 verification run
      // could not tell apart. "ping timeout" means THIS server gave up waiting
      // for a pong; "transport error" means the connection broke underneath
      // it; "transport close" means it observed a clean close it did not
      // initiate. All 100 sockets dying within 13ms of each other while having
      // connected across ~5s already rules out a per-socket timeout, so a
      // tally of "ping timeout" here would be the surprise, not the
      // expectation — see the Phase 12 plan's reading table.
      disconnectReasonCounts[reason] = (disconnectReasonCounts[reason] ?? 0) + 1;

      const roomId = socket.data.roomId as string | undefined;
      // Fire-and-forget: removePeer is async since it may flush pending object
      // writes on eviction, but a disconnecting socket has nothing left to
      // wait on the result for. A crash between now and flush completion can
      // still lose at most one debounce window of edits — the same documented
      // limitation as the debounce itself (see objectPersistence.ts).
      // socket.id so a stale socket's disconnect can't remove a peer that has
      // since re-joined on a newer one — see RoomManager.removePeer.
      if (roomId) void roomManager.removePeer(roomId, user.userId, socket.id);
    });
  });
}
