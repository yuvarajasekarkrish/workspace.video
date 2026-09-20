import { io, type Socket } from "socket.io-client";
import {
  ClientEvents,
  ServerEvents,
  PeersSnapshotEventSchema,
  PeersDeltaEventSchema,
  MoveCorrectionEventSchema,
  OwnerChangedEventSchema,
  ObjectsSnapshotEventSchema,
  ObjectSyncEventSchema,
  ObjectRemovedEventSchema,
  OccupancyUpdateEventSchema,
  SeatsSnapshotEventSchema,
  SeatUpdateEventSchema,
  ZoneChangedEventSchema,
  type MoveEvent,
  type ObjectUpsertEvent,
  type ObjectDeleteEvent,
} from "@workspace-video/shared";
import { peersStore } from "@/store/peersStore";
import { connectionStore } from "@/store/connectionStore";
import { proximityStore } from "@/store/proximityStore";
import { applyProximityUpdate, applyProximityBatch } from "./proximityEvents";
import { objectsStore } from "@/store/objectsStore";
import { occupancyStore } from "@/store/occupancyStore";
import { seatsStore } from "@/store/seatsStore";
import { zoneStore } from "@/store/zoneStore";

export interface RoomEndpoint {
  instanceId: string;
  publicUrl: string;
}

export interface RealtimeClientCallbacks {
  /** Server rejected our last move; snap the local avatar to this position. */
  onMoveCorrection: (position: { x: number; y: number }) => void;
}

const RECONNECT_BASE_DELAY_MS = 500;
const RECONNECT_MAX_DELAY_MS = 8_000;

/**
 * Owns the entire socket lifecycle for one room: resolving which realtime
 * instance to talk to, connecting, joining, and recovering from every kind
 * of disruption the backend's sticky-ownership design can produce.
 *
 * Two distinct failure modes matter here, and they get different treatment:
 *
 *   1. Ordinary connection drop (network blip, tab backgrounded) - socket.io
 *      itself reconnects to the same URL; we just need to re-join_room on
 *      every "connect" event, because the realtime server has no memory of
 *      a disconnected socket's room membership.
 *   2. Loss of room ownership ("owner:changed" event, or a join_room ack
 *      with {error:"not_owner"}) - the instance we're talking to is no
 *      longer authoritative for this room. Retrying the same socket is
 *      wrong; we must re-resolve /api/rooms/:id/endpoint from scratch,
 *      which may hand us a different instance's URL entirely.
 *
 * Every peers:snapshot (whether from the initial join or a later resync) is
 * applied as a WHOLESALE replacement of the roster - this is the single
 * rule that prevents ghost/duplicate avatars after a reconnect: we never
 * merge, only replace.
 */
export class RealtimeClient {
  private socket: Socket | null = null;
  private disposed = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly roomId: string,
    private readonly localUserId: string,
    private readonly callbacks: RealtimeClientCallbacks,
  ) {}

  async connect(): Promise<void> {
    if (this.disposed) return;
    await this.resolveAndConnect();
  }

  /** Sends a move if the socket is currently connected and joined; silently
   *  drops it otherwise (the caller's throttle/dedup logic in
   *  input/movement.ts already decides *when* to call this). */
  sendMove(event: MoveEvent): void {
    this.socket?.emit(ClientEvents.Move, event);
  }

  /** Sends an object create/edit. Fire-and-forget, like sendMove — the
   *  server's reconciliation (object:sync, broadcast to the whole room
   *  including the sender) is what the client actually reacts to, not the
   *  ack, so no ack callback is registered here. */
  sendObjectUpsert(event: ObjectUpsertEvent): void {
    this.socket?.emit(ClientEvents.ObjectUpsert, event);
  }

  sendObjectDelete(event: ObjectDeleteEvent): void {
    this.socket?.emit(ClientEvents.ObjectDelete, event);
  }

  /** Sit-down waits for the ack (a claim can legitimately be refused —
   *  taken, out of range), unlike sendMove/sendObjectUpsert's fire-and-
   *  forget style; resolves `{ok:true}` or `{ok:false, error}` rather than
   *  throwing, since a rejection is an expected outcome, not a failure. */
  sendSeatClaim(seatId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    return new Promise((resolve) => {
      if (!this.socket) return resolve({ ok: false, error: "not_connected" });
      this.socket.emit(ClientEvents.SeatClaim, { seatId }, (ack: unknown) => {
        const ackObj = ack as { ok?: boolean; error?: string } | undefined;
        if (ackObj?.error) resolve({ ok: false, error: ackObj.error });
        else resolve({ ok: true });
      });
    });
  }

  /** Fire-and-forget, unlike sendSeatClaim — standing up is optimistic on
   *  the client (see MovementController's onStandUp) and release is
   *  idempotent server-side, so there is nothing meaningful an ack could
   *  change about local state here. */
  sendSeatRelease(): void {
    this.socket?.emit(ClientEvents.SeatRelease, {});
  }

  dispose(): void {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.teardownSocket();
  }

  private async resolveAndConnect(): Promise<void> {
    if (this.disposed) return;
    connectionStore.getState().setStatus("resolving-endpoint");

    let endpoint: RoomEndpoint;
    try {
      endpoint = await this.fetchEndpoint();
    } catch (err) {
      this.scheduleReconnect((err as Error).message);
      return;
    }

    this.teardownSocket();
    if (this.disposed) return;

    connectionStore.getState().setStatus("connecting");

    const token = await this.fetchRealtimeToken();
    if (!token || this.disposed) {
      this.scheduleReconnect("Failed to obtain a realtime token.");
      return;
    }

    const socket = io(endpoint.publicUrl, {
      auth: { token },
      reconnection: true, // handles ordinary drops; owner changes are handled separately below
    });
    this.socket = socket;

    socket.on("connect", () => this.joinRoom());
    socket.on("connect_error", (err) => this.scheduleReconnect(err.message));

    socket.on(ServerEvents.PeersSnapshot, (raw) => {
      const parsed = PeersSnapshotEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.roomId !== this.roomId) return;
      peersStore.getState().applySnapshot(this.localUserId, parsed.data.peers);
      // A snapshot is a wholesale roster replacement — any cached desired-
      // audio state for a userId no longer present must be dropped too, or
      // it survives a reload/resync under a reused userId. Same rule,
      // applied to the audio side of the same event.
      proximityStore.getState().pruneToRoster(new Set(parsed.data.peers.map((p) => p.userId)));
      // Every join re-broadcasts the current occupancy to the whole room —
      // this is how existing clients' counts stay current on the join path
      // (the leave path has no snapshot, so it uses occupancy:update below).
      occupancyStore.getState().setOccupancy(parsed.data.active, parsed.data.limit);
    });

    socket.on(ServerEvents.OccupancyUpdate, (raw) => {
      const parsed = OccupancyUpdateEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.roomId !== this.roomId) return;
      occupancyStore.getState().setOccupancy(parsed.data.active, parsed.data.limit);
    });

    socket.on(ServerEvents.PeersDelta, (raw) => {
      const parsed = PeersDeltaEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.roomId !== this.roomId) return;
      peersStore.getState().applyDelta(parsed.data.updates, parsed.data.left);
      for (const userId of parsed.data.left) {
        proximityStore.getState().removePeer(userId);
      }
    });

    socket.on(ServerEvents.MoveCorrection, (raw) => {
      const parsed = MoveCorrectionEventSchema.safeParse(raw);
      if (!parsed.success) return;
      this.callbacks.onMoveCorrection(parsed.data.position);
    });

    // Written straight into proximityStore, exactly as peers:snapshot/delta
    // are written straight into peersStore above — PixiStage stays purely
    // visual and unaware of audio; SpatialAudioController is the only
    // reader, via getState()/subscribe(), never a React hook (see the
    // approved LiveKit plan's no-rerender rule for the audio-store split).
    // Two framings of the same information. We opt in to the batch in
    // joinRoom(), but keep the per-peer handler: an older server never sends
    // the batch, and the server's kill switch sends per-peer to opted-in
    // clients too.
    socket.on(ServerEvents.ProximityUpdate, (raw) => {
      applyProximityUpdate(raw);
    });
    socket.on(ServerEvents.ProximityBatch, (raw) => {
      applyProximityBatch(raw);
    });

    // Wholesale replacement, exactly like peers:snapshot — sent only to
    // the joining/reconnecting socket (see server.ts), never broadcast to
    // the whole room, since an existing peer's knowledge of the room's
    // objects doesn't change just because someone else joined.
    socket.on(ServerEvents.ObjectsSnapshot, (raw) => {
      const parsed = ObjectsSnapshotEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.roomId !== this.roomId) return;
      objectsStore.getState().applySnapshot(parsed.data.objects);
    });

    // Broadcast to the whole room (including the sender) on every accepted
    // upsert, and sent to the rejecting socket alone on a stale/rejected
    // one — objectsStore.applySync's accepted flag is what tells a
    // currently-dragging client not to let this yank its in-flight render.
    socket.on(ServerEvents.ObjectSync, (raw) => {
      const parsed = ObjectSyncEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.object.roomId !== this.roomId) return;
      objectsStore.getState().applySync(parsed.data.object, parsed.data.accepted);
    });

    socket.on(ServerEvents.ObjectRemoved, (raw) => {
      const parsed = ObjectRemovedEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.roomId !== this.roomId) return;
      objectsStore.getState().applyRemoved(parsed.data.objectId);
    });

    // Wholesale replacement, sent only to the joining/reconnecting socket —
    // same primitive and reasoning as objects:snapshot above.
    socket.on(ServerEvents.SeatsSnapshot, (raw) => {
      const parsed = SeatsSnapshotEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.roomId !== this.roomId) return;
      seatsStore.getState().applySnapshot(parsed.data.occupancy);
    });

    // Broadcast to the whole room on every occupancy change. Note this
    // never touches MovementController's local `seated` flag — see
    // seatsStore.ts's docs on that ownership boundary — so an echo of our
    // own seat arriving here after we've already stood up locally is inert.
    socket.on(ServerEvents.SeatUpdate, (raw) => {
      const parsed = SeatUpdateEventSchema.safeParse(raw);
      if (!parsed.success) return;
      seatsStore.getState().applyUpdate(parsed.data.seatId, parsed.data.userId);
    });

    // Sent only to this socket, whenever OUR OWN zone membership changes —
    // drives the zone toast and HUD chip (see components/ZoneToast.tsx,
    // ZoneHudChip.tsx). Not roomId-scoped since it carries no roomId of its
    // own (it's inherently about "this connection", already known to be in
    // exactly one room).
    socket.on(ServerEvents.ZoneChanged, (raw) => {
      const parsed = ZoneChangedEventSchema.safeParse(raw);
      if (!parsed.success) return;
      zoneStore.getState().setZone(parsed.data.zone);
    });

    // The instance we're connected to is no longer authoritative for this
    // room - re-resolve from scratch rather than retry it (see class docs).
    socket.on(ServerEvents.OwnerChanged, (raw) => {
      const parsed = OwnerChangedEventSchema.safeParse(raw);
      if (!parsed.success || parsed.data.roomId !== this.roomId) return;
      this.scheduleReconnect("Room ownership changed.");
    });

    socket.on("disconnect", (reason) => {
      if (this.disposed) return;
      connectionStore.getState().setStatus("reconnecting");
      // socket.io's built-in reconnection handles a normal drop by retrying
      // the same URL and firing "connect" again (re-joining above). Only a
      // server-initiated disconnect (e.g. this instance evicted the room -
      // see apps/realtime RoomManager.evictRoom) needs a full re-resolve,
      // since the same URL may no longer be the room's owner at all.
      if (reason === "io server disconnect") {
        this.scheduleReconnect("Disconnected by server.");
      }
    });
  }

  /** Re-sends join_room on the already-connected socket — the capacity
   *  screen's "Try again" button calls this (via PixiStage.retryJoin) rather
   *  than tearing down and re-resolving the endpoint, since a workspace_full
   *  rejection means nothing about the socket/endpoint was wrong. */
  retryJoin(): void {
    this.joinRoom();
  }

  private joinRoom(): void {
    if (!this.socket || this.disposed) return;
    connectionStore.getState().setStatus("joining");
    connectionStore.getState().setCapacity(null);

    // proximityBatch is this CONNECTION's declaration that it understands
    // proximity:batch; it is re-sent on every join (first join, retry, reconnect).
    this.socket.emit(ClientEvents.JoinRoom, { roomId: this.roomId, proximityBatch: true }, (ack: unknown) => {
      if (this.disposed) return;
      const ackObj = ack as { ok?: boolean; error?: string; limit?: number; active?: number } | undefined;

      if (ackObj?.error === "not_owner") {
        this.scheduleReconnect("Not the room owner; re-resolving.");
        return;
      }
      if (ackObj?.error === "workspace_full") {
        // Deliberately not scheduleReconnect: the socket/endpoint are fine,
        // and auto-retrying a full workspace on a timer would just hammer
        // the server. The user retries explicitly instead.
        connectionStore.getState().setCapacity({
          active: ackObj.active ?? 0,
          limit: ackObj.limit ?? 0,
        });
        connectionStore.getState().setStatus("workspace_full");
        return;
      }
      if (ackObj?.error) {
        connectionStore.getState().setError(ackObj.error);
        connectionStore.getState().setStatus("error");
        return;
      }

      this.reconnectAttempt = 0; // successful join resets backoff
      connectionStore.getState().setStatus("connected");
      connectionStore.getState().setError(null);
      connectionStore.getState().setCapacity(null);
    });
  }

  private scheduleReconnect(reason: string): void {
    if (this.disposed) return;
    connectionStore.getState().setError(reason);
    connectionStore.getState().setStatus("reconnecting");
    this.teardownSocket();

    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** this.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS,
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => void this.resolveAndConnect(), delay);
  }

  private teardownSocket(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  private async fetchEndpoint(): Promise<RoomEndpoint> {
    const res = await fetch(`/api/rooms/${encodeURIComponent(this.roomId)}/endpoint`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body?.error ?? `Endpoint resolution failed (${res.status}).`);
    }
    return res.json();
  }

  private async fetchRealtimeToken(): Promise<string | null> {
    const res = await fetch("/api/auth/realtime-token");
    if (!res.ok) return null;
    const body = await res.json();
    return body.token ?? null;
  }
}
