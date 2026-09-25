import type { Server as SocketIOServer, Socket } from "socket.io";
import type { RoomLease } from "@workspace-video/realtime-core";
import {
  ClientEvents,
  ServerEvents,
  JoinRoomEventSchema,
  MoveEventSchema,
  MoveToEventSchema,
  ObjectUpsertEventSchema,
  ObjectDeleteEventSchema,
  SeatClaimEventSchema,
  SeatReleaseEventSchema,
  SeatSelectEventSchema,
  resolveRoomLayout,
  zoneById,
  zoneAt,
  seatById,
  tileRectCenter,
  movementConfigForLayout,
  DEFAULT_MOVEMENT_CONFIG,
  type PeersSnapshotEvent,
  type PeersDeltaEvent,
  type ObjectsSnapshotEvent,
  type SeatsSnapshotEvent,
  type RoomLayout,
  type MovementConfig,
  type ParticipantLimitProvider,
  type Point,
} from "@workspace-video/shared";
import { spawnPositionForUser } from "@workspace-video/proximity";
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
  auth: Pick<typeof Auth, "verifySessionToken" | "assertRoomMembership" | "assertWorkspaceMembership" | "getWorkspaceRole">;
  /** Called once per new connection, before its handlers attach — server.ts
   *  uses it for heartbeat sampling; tests leave it unset. */
  onConnection?: (socket: Socket) => void;
  /** Phase 17 diagnostics: times the emits made directly on Socket.IO here,
   *  which never pass through CountingBroadcaster. Read-only; unset in tests
   *  that do not care. */
  emitTail?: EmitTailRecorder;
  /** Called when a room's stored map failed its checks and the room fell back to another layout,
   *  with the reason. server.ts logs it; tests leave it unset. */
  onLayoutProblem?: (info: { roomId: string; problem: string }) => void;
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
  const { verifySessionToken, assertRoomMembership, assertWorkspaceMembership, getWorkspaceRole } = deps.auth;

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

    /** Refreshes this peer's role snapshot with a fresh database read, but
     *  ONLY when `target`'s zone is actually restricted — the overwhelming
     *  common case (an open zone, including every zone that existed before
     *  Part 4A) costs nothing extra: no DB call, no await, same as before
     *  access control existed. See PeerState.role's docs and
     *  RoomManager.checkZoneAccess. */
    const refreshRoleIfZoneRestricted = async (roomId: string, target: Point): Promise<void> => {
      const info = roomManager.getRoomInfo(roomId);
      if (!info) return;
      const zone = zoneAt(info.layout, target);
      if (!zone?.access || zone.access.kind === "open") return;
      const role = await getWorkspaceRole(user.userId, info.workspaceId);
      roomManager.setPeerRole(roomId, user.userId, role);
    };

    socket.on(ClientEvents.JoinRoom, async (raw, ack?: (res: unknown) => void) => {
      const joinStartedAt = performance.now();
      const finish = (res: unknown) => {
        joinDuration.record(performance.now() - joinStartedAt);
        return ack?.(res);
      };

      const parsed = JoinRoomEventSchema.safeParse(raw);
      if (!parsed.success) return finish({ error: "Invalid join payload." });

      const { roomId, proximityBatch } = parsed.data;

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

        // Resolved from Room.config by the ONE function the room page also
        // uses, so client and server always agree on floor bounds and the
        // spawn point (see resolveRoomLayout in @workspace-video/shared). A
        // company's own map that fails its checks falls back to the room's
        // named or default layout instead of bricking the room, and the
        // reason is reported, never swallowed.
        const resolved = resolveRoomLayout(roomConfig);
        layout = resolved.layout;
        if (resolved.problem) deps.onLayoutProblem?.({ roomId, problem: resolved.problem });
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
          // @workspace-video/shared) — the rest of this flow is unaffected.
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

      // Fresh role read for the zone-access bounded-staleness snapshot (see
      // PeerState.role's docs) — but ONLY when this layout actually has a
      // restricted zone anywhere: every workspace today has none (this is a
      // brand-new opt-in field), so every join stays exactly as fast as it
      // was before Part 4A for every one of them. Once a workspace does add
      // a restricted zone, its own joins pay one extra read; nobody else's
      // do.
      const hasRestrictedZone = layout.zones.some((z) => z.access?.kind === "restricted");
      const role = hasRestrictedZone ? await getWorkspaceRole(user.userId, workspaceId) : null;

      // admitAndAddPeer checks capacity and inserts the peer in one synchronous
      // call, so two sockets racing for the last slot can't both be admitted.
      // Rejected: do NOT join the socket to the room and do not broadcast
      // anything — nothing about the room's state changes for a refused join.
      // Computed once, reused both for admission and for the introduction
      // delta below — never recomputed, so the two can't ever disagree.
      const spawnPosition = spawnPositionForUser(user.userId, tileRectCenter(spawnZone.rect), undefined, movementConfig);
      const admission = roomManager.admitAndAddPeer(roomId, {
        userId: user.userId,
        name: user.email, // placeholder until profile data is wired up in phase 2
        avatarUrl: null,
        socketId: socket.id,
        // This connection's own declaration, stored next to its socket id so
        // both are replaced together by the latest join (see PeerState).
        proximityBatch: proximityBatch === true,
        position: spawnPosition,
        role: role ?? undefined,
      }, limit);

      if (!admission.admitted) {
        return finish({ error: "workspace_full", limit: admission.limit, active: admission.active });
      }

      await socket.join(roomId);
      socket.data.roomId = roomId;

      // The full roster goes to the JOINING socket only — this is the one
      // place it's genuinely needed (a brand-new connection has nothing yet;
      // this also doubles as its own clean-resync primitive on reconnect).
      // Broadcasting the WHOLE roster to the WHOLE room on every single join
      // used to cost O(room size) work times O(room size) recipients — a
      // real, measured load-test finding (300 concurrent joins: 5+ seconds
      // of cumulative emit time on this one event alone). Existing peers
      // instead get a minimal introduction below.
      const occ = roomManager.occupancy(roomId);
      const snapshot: PeersSnapshotEvent = { roomId, peers: roomManager.snapshot(roomId), ...occ };
      timed(ServerEvents.PeersSnapshot, toOne, snapshot, () => socket.emit(ServerEvents.PeersSnapshot, snapshot));

      // Existing peers learn the newcomer's identity via a peers:delta entry
      // carrying name/avatarUrl (see PeersDeltaEventSchema's docs) instead of
      // the full roster — one small broadcast instead of re-sending
      // everyone's record to everyone. `socket.to` (not `io.to`) excludes the
      // joiner itself, which already has its own full snapshot above.
      const introduction: PeersDeltaEvent = {
        roomId,
        updates: [{ userId: user.userId, position: spawnPosition, name: user.email, avatarUrl: null }],
        left: [],
      };
      timed(ServerEvents.PeersDelta, roomSize(roomId), introduction, () => socket.to(roomId).emit(ServerEvents.PeersDelta, introduction));

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
        // access_denied carries no correctedPosition (nothing was ever
        // accepted to correct away from) — report the peer's own current,
        // unchanged position instead, so the client still has something
        // valid to snap to; see RoomManager.applyMove's access-check docs.
        const position = "correctedPosition" in result ? result.correctedPosition : (roomManager.getPeerPosition(roomId, user.userId) ?? parsed.data.position);
        const correction = { position, reason: result.reason };
        timed(ServerEvents.MoveCorrection, toOne, correction, () => socket.emit(ServerEvents.MoveCorrection, correction));
      }
    });

    socket.on(ClientEvents.MoveTo, async (raw) => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return;

      const parsed = MoveToEventSchema.safeParse(raw);
      if (!parsed.success) return;

      await refreshRoleIfZoneRestricted(roomId, parsed.data.position);

      const result = roomManager.teleportTo(roomId, user.userId, parsed.data.position);
      if (result && !result.accepted) {
        const position = "correctedPosition" in result ? result.correctedPosition : (roomManager.getPeerPosition(roomId, user.userId) ?? parsed.data.position);
        const correction = { position, reason: result.reason };
        timed(ServerEvents.MoveCorrection, toOne, correction, () => socket.emit(ServerEvents.MoveCorrection, correction));
      }
    });

    socket.on(ClientEvents.SeatClaim, async (raw, ack?: (res: unknown) => void) => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return ack?.({ error: "not_in_room" });

      const parsed = SeatClaimEventSchema.safeParse(raw);
      if (!parsed.success) return ack?.({ error: "invalid_payload" });

      const info = roomManager.getRoomInfo(roomId);
      const seat = info ? seatById(info.layout, parsed.data.seatId) : undefined;
      if (seat) await refreshRoleIfZoneRestricted(roomId, seat.anchor);

      const result = roomManager.claimSeat(roomId, user.userId, parsed.data.seatId);
      if (!result) return ack?.({ error: "room_not_found" });
      if (!result.accepted) return ack?.({ error: result.reason });
      ack?.({ ok: true });
    });

    // Part 4B: auto-seat-within-table / nearby-seat search, plus "exact" for
    // a client that wants to route every strategy through one event. Same
    // ack-callback shape as seat:claim (a rejection is an expected outcome,
    // not a transport failure) so the client's existing error-handling
    // pattern extends here without inventing a second convention.
    socket.on(ClientEvents.SeatSelect, async (raw, ack?: (res: unknown) => void) => {
      const roomId = socket.data.roomId as string | undefined;
      if (!roomId) return ack?.({ error: "not_in_room" });

      const parsed = SeatSelectEventSchema.safeParse(raw);
      if (!parsed.success) return ack?.({ error: "invalid_payload" });

      const info = roomManager.getRoomInfo(roomId);
      // Best-effort role refresh: use the exact seat's anchor when the
      // request names one, otherwise the given search point — whichever the
      // request actually supplies is the best guess at the destination
      // available before the strategy resolves its real candidate. The
      // candidate ultimately chosen still goes through checkZoneAccess
      // inside RoomManager.selectSeat using whatever role snapshot is
      // current at that point, exactly like seat:claim/move:to.
      const refreshTarget =
        "seatId" in parsed.data.target
          ? info && seatById(info.layout, parsed.data.target.seatId)?.anchor
          : parsed.data.target.point;
      if (refreshTarget) await refreshRoleIfZoneRestricted(roomId, refreshTarget);

      const result = roomManager.selectSeat(roomId, user.userId, parsed.data);
      if (!result) return ack?.({ error: "room_not_found" });
      if (result.outcome === "failed") return ack?.({ error: result.reason });
      ack?.(result);
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
