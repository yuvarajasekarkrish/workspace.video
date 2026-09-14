import { io, type Socket } from "socket.io-client";
import {
  ClientEvents,
  ServerEvents,
  PeersSnapshotEventSchema,
  PeersDeltaEventSchema,
  MoveCorrectionEventSchema,
  ProximityUpdateEventSchema,
  OwnerChangedEventSchema,
  ObjectsSnapshotEventSchema,
  ObjectSyncEventSchema,
  ObjectRemovedEventSchema,
  type MoveEvent,
  type ObjectUpsertEvent,
  type ObjectDeleteEvent,
} from "@cosmos/shared";
import { peersStore } from "@/store/peersStore";
import { connectionStore } from "@/store/connectionStore";
import { proximityStore } from "@/store/proximityStore";
import { objectsStore } from "@/store/objectsStore";

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
    socket.on(ServerEvents.ProximityUpdate, (raw) => {
      const parsed = ProximityUpdateEventSchema.safeParse(raw);
      if (!parsed.success) return;
      proximityStore.getState().setPeerProximity(parsed.data.peerId, {
        audioSubscribed: parsed.data.audioSubscribed,
        audioGain: parsed.data.audioGain,
      });
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

  private joinRoom(): void {
    if (!this.socket || this.disposed) return;
    connectionStore.getState().setStatus("joining");

    this.socket.emit(ClientEvents.JoinRoom, { roomId: this.roomId }, (ack: unknown) => {
      if (this.disposed) return;
      const ackObj = ack as { ok?: boolean; error?: string } | undefined;

      if (ackObj?.error === "not_owner") {
        this.scheduleReconnect("Not the room owner; re-resolving.");
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
