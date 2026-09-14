import { Room, RoomEvent, Track } from "livekit-client";
import { proximityStore } from "@/store/proximityStore";
import { mediaStore } from "@/store/mediaStore";
import {
  diffSubscriptions,
  desiredSubscribedPeerIds,
  resolveTargetGain,
  stepGainToward,
  hasGainConverged,
} from "./spatialAudio";

const GAIN_STEP_INTERVAL_MS = 50;

export interface SpatialAudioTokenResponse {
  token: string;
  url: string;
}

// ---------------------------------------------------------------------------
// Narrow structural interfaces over the livekit-client surface this
// controller actually uses. Mirrors the existing RoomBroadcaster seam in
// apps/realtime/src/roomManager.ts (a narrow interface over Socket.IO's
// Server so unit tests can pass a lightweight fake instead of a real one) —
// same reasoning here: `Room` is a concrete class with private members, so a
// hand-written fake object cannot be assigned TO it, but a real `Room`
// instance IS structurally assignable to a narrower public interface like
// this one. Every member below was verified against the installed
// livekit-client@2.22.3 .d.ts files before being relied on here.
// ---------------------------------------------------------------------------

export interface LiveKitTrackPublicationLike {
  readonly trackSid: string;
  readonly isSubscribed: boolean;
  setSubscribed(subscribed: boolean): void;
}

export interface LiveKitAudioTrackLike {
  readonly kind: string;
  attach(): HTMLMediaElement;
  detach(element: HTMLMediaElement): HTMLMediaElement;
}

export interface LiveKitRemoteParticipantLike {
  readonly identity: string;
  readonly audioTrackPublications: ReadonlyMap<string, LiveKitTrackPublicationLike>;
  setVolume(volume: number): void;
}

export interface LiveKitLocalParticipantLike {
  setMicrophoneEnabled(enabled: boolean): Promise<unknown>;
}

export interface LiveKitRoomLike {
  readonly remoteParticipants: ReadonlyMap<string, LiveKitRemoteParticipantLike>;
  readonly localParticipant: LiveKitLocalParticipantLike;
  readonly canPlaybackAudio: boolean;
  connect(url: string, token: string, opts?: { autoSubscribe?: boolean }): Promise<void>;
  disconnect(): Promise<void>;
  startAudio(): Promise<void>;
  removeAllListeners(): void;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

function defaultRoomFactory(): LiveKitRoomLike {
  return new Room() as unknown as LiveKitRoomLike;
}

/**
 * Owns the LiveKit room connection for one room visit: connecting,
 * publishing the local mic on request, and continuously reconciling
 * *desired* audio (proximityStore, driven by the server's proximity:update)
 * against *actual* LiveKit subscription/volume state. Never stored in React
 * state — same rule as PixiStage's Application and RealtimeClient's Socket.
 *
 * DESIGN: never act directly on a single LiveKit or socket event. Every
 * trigger (a proximity update, a participant connecting, a track
 * publishing, a reconnect) just calls the same idempotent `reconcile()`,
 * which diffs desired vs. actual and applies exactly the difference. This
 * is what makes the ordering between the Socket.IO connection and the
 * LiveKit connection irrelevant — see the race table in the approved plan.
 *
 * Gain is smoothed on a SELF-STOPPING setTimeout chain, deliberately not:
 *   - the Pixi ticker / requestAnimationFrame — Milestone 1 found Chromium
 *     throttles/pauses rAF for a backgrounded tab, which would freeze a
 *     volume ramp mid-transition (and audio must keep converging even when
 *     the canvas tab isn't focused);
 *   - a permanent setInterval — wasteful to run forever once every peer's
 *     gain has already converged to its target.
 * The loop starts when a target changes and stops itself once every active
 * peer's smoothed gain is within epsilon of target.
 */
export class SpatialAudioController {
  private room: LiveKitRoomLike | null = null;
  private disposed = false;
  private micEnabled = false;

  /** Smoothed (currently-playing) gain per peer, separate from the
   *  *target* gain living in proximityStore — this is exactly the
   *  render-vs-target split canvas/interpolation.ts uses for position. */
  private currentGain = new Map<string, number>();
  private gainRampTimer: ReturnType<typeof setTimeout> | null = null;
  private gainRampLastTickMs: number | null = null;
  private attachedElements = new Map<string, HTMLMediaElement>();

  private unsubscribeProximity: (() => void) | null = null;

  constructor(
    private readonly roomId: string,
    private readonly localUserId: string,
    private readonly fetchToken: () => Promise<SpatialAudioTokenResponse>,
    private readonly createRoom: () => LiveKitRoomLike = defaultRoomFactory,
  ) {}

  async connect(): Promise<void> {
    if (this.disposed) return;
    mediaStore.getState().setStatus("connecting");
    mediaStore.getState().setError(null);

    let creds: SpatialAudioTokenResponse;
    try {
      creds = await this.fetchToken();
    } catch (err) {
      if (this.disposed) return;
      mediaStore.getState().setStatus("error");
      mediaStore.getState().setError((err as Error).message);
      return;
    }
    if (this.disposed) return;

    const room = this.createRoom();
    this.room = room;
    this.attachRoomListeners(room);

    try {
      // autoSubscribe: false — subscription is entirely driven by
      // proximity:update via reconcile(), never LiveKit's own default.
      await room.connect(creds.url, creds.token, { autoSubscribe: false });
    } catch (err) {
      if (this.disposed) return;
      mediaStore.getState().setStatus("error");
      mediaStore.getState().setError((err as Error).message);
      return;
    }
    if (this.disposed) {
      await room.disconnect();
      return;
    }

    mediaStore.getState().setStatus("connected");
    mediaStore.getState().setCanPlaybackAudio(room.canPlaybackAudio);

    // With autoSubscribe: false, LiveKit never fires TrackPublished for
    // tracks published BEFORE this participant joined (confirmed against
    // the installed livekit-client typings: ParticipantConnected's own doc
    // comment makes the equivalent statement for participants). Sweep
    // what's already present once, up front, so joining a room
    // mid-conversation isn't silence until someone happens to re-publish.
    this.reconcile();

    // Desired state changes at up to 10Hz while peers move — this is
    // exactly the peersStore-style subscription proximityStore warns
    // about, and it is read here via subscribe(), never by a React
    // component, so the no-rerender rule is untouched.
    this.unsubscribeProximity = proximityStore.subscribe(() => this.reconcile());
  }

  /** Called only from the user's "Enable audio" click — never automatically.
   *  Order matters: unlocking playback first is what turns a subsequent
   *  TrackSubscribed's attached <audio> element into audible sound instead
   *  of a silently-blocked one. */
  async enableAudio(): Promise<void> {
    const room = this.room;
    if (!room || this.disposed) return;

    await room.startAudio();
    mediaStore.getState().setCanPlaybackAudio(room.canPlaybackAudio);

    await room.localParticipant.setMicrophoneEnabled(true);
    if (this.disposed) return;
    this.micEnabled = true;
    mediaStore.getState().setMicEnabled(true);

    // Re-attach/play anything already subscribed, now that playback is
    // unlocked and our own mic publication exists.
    this.reconcile();
  }

  async setMuted(muted: boolean): Promise<void> {
    const room = this.room;
    if (!room || this.disposed || !this.micEnabled) return;
    await room.localParticipant.setMicrophoneEnabled(!muted);
    mediaStore.getState().setMicEnabled(!muted);
  }

  async dispose(): Promise<void> {
    this.disposed = true;

    this.unsubscribeProximity?.();
    this.unsubscribeProximity = null;

    // A step already scheduled must not re-arm after this point; clearing
    // the handle plus the disposed flag together are what make the chain
    // actually stop rather than just skip one tick.
    if (this.gainRampTimer) {
      clearTimeout(this.gainRampTimer);
      this.gainRampTimer = null;
    }

    for (const el of this.attachedElements.values()) {
      el.remove();
    }
    this.attachedElements.clear();

    const room = this.room;
    this.room = null;
    if (room) {
      if (this.micEnabled) {
        // Stop the local track explicitly so the browser's recording
        // indicator actually clears — disconnect() alone does not
        // guarantee this on every browser.
        await room.localParticipant.setMicrophoneEnabled(false).catch(() => {});
      }
      room.removeAllListeners();
      await room.disconnect();
    }

    // Deliberately NOT calling mediaStore.getState().reset() here. mediaStore
    // is a shared, module-level singleton, and React 19 StrictMode
    // double-invokes effects in dev: RoomCanvas briefly creates two
    // SpatialAudioController instances back-to-back, and this dispose() runs
    // for the first (throwaway) one. Its async teardown can resolve AFTER
    // the second, real controller has already connected and written
    // status: "connected" — an unconditional reset() here would then wipe
    // that back to "idle" out from under a controller that is very much
    // still alive, permanently hiding the "Enable audio" button (this was
    // reproduced during manual verification). RealtimeClient has the exact
    // same shape of race with connectionStore and, for the same reason,
    // never resets it in dispose() either — status is left as last-write-
    // wins, which is harmless once the component (and the whole page) has
    // actually unmounted for good.
  }

  // -------------------------------------------------------------------
  // Reconciliation
  // -------------------------------------------------------------------

  /** Idempotent: diffs desired (proximityStore) against actual (LiveKit's
   *  own subscription state) and applies exactly the difference. Safe to
   *  call redundantly from any trigger — a socket event, a LiveKit event,
   *  or the initial post-connect sweep. */
  private reconcile(): void {
    const room = this.room;
    if (!room || this.disposed) return;

    const desired = proximityStore.getState().desired;
    const desiredIds = desiredSubscribedPeerIds(desired);

    const actualIds = new Set<string>();
    for (const [peerId, participant] of room.remoteParticipants) {
      if (peerId === this.localUserId) continue; // defensive; should never appear in remoteParticipants
      for (const pub of participant.audioTrackPublications.values()) {
        if (pub.isSubscribed) actualIds.add(peerId);
      }
    }

    const { toSubscribe, toUnsubscribe } = diffSubscriptions(desiredIds, actualIds);

    for (const peerId of toSubscribe) {
      this.setPeerSubscribed(room.remoteParticipants.get(peerId), true);
    }
    for (const peerId of toUnsubscribe) {
      this.setPeerSubscribed(room.remoteParticipants.get(peerId), false);
    }

    this.ensureGainRampRunning(desired);
  }

  private setPeerSubscribed(
    participant: LiveKitRemoteParticipantLike | undefined,
    subscribed: boolean,
  ): void {
    if (!participant) return;
    for (const pub of participant.audioTrackPublications.values()) {
      // setSubscribed with the current value is documented as a no-op, so
      // calling this redundantly from repeated reconcile() runs is safe.
      pub.setSubscribed(subscribed);
    }
  }

  // -------------------------------------------------------------------
  // Gain ramp — self-stopping setTimeout chain (see class docs)
  // -------------------------------------------------------------------

  private ensureGainRampRunning(desired: ReturnType<typeof proximityStore.getState>["desired"]): void {
    if (this.gainRampTimer !== null) return; // already running; it will pick up the new targets on its next tick
    if (this.allGainsConverged(desired)) return;

    this.gainRampLastTickMs = Date.now();
    this.scheduleGainRampTick();
  }

  private allGainsConverged(desired: ReturnType<typeof proximityStore.getState>["desired"]): boolean {
    const room = this.room;
    if (!room) return true;

    for (const [peerId] of room.remoteParticipants) {
      const target = resolveTargetGain(desired, peerId);
      const current = this.currentGain.get(peerId) ?? 0;
      if (!hasGainConverged(current, target)) return false;
    }
    return true;
  }

  private scheduleGainRampTick(): void {
    this.gainRampTimer = setTimeout(() => this.runGainRampTick(), GAIN_STEP_INTERVAL_MS);
  }

  private runGainRampTick(): void {
    this.gainRampTimer = null;
    if (this.disposed) return; // dispose() already tore things down; do not re-arm

    const room = this.room;
    if (!room) return;

    const now = Date.now();
    const dtSeconds = (now - (this.gainRampLastTickMs ?? now)) / 1000;
    this.gainRampLastTickMs = now;

    const desired = proximityStore.getState().desired;
    let stillConverging = false;

    for (const [peerId, participant] of room.remoteParticipants) {
      const target = resolveTargetGain(desired, peerId);
      const current = this.currentGain.get(peerId) ?? 0;
      const next = stepGainToward(current, target, dtSeconds);
      this.currentGain.set(peerId, next);

      // setVolume applies per participant; harmless to call every tick, and
      // cheap — the same "write every frame, no subscriber notified" shape
      // as the Pixi ticker writing renderPosition in place.
      participant.setVolume(next);

      if (!hasGainConverged(next, target)) stillConverging = true;
    }

    if (stillConverging) {
      this.scheduleGainRampTick();
    }
    // else: converged — the loop simply stops. ensureGainRampRunning() will
    // restart it the next time a proximity update moves a target.
  }

  // -------------------------------------------------------------------
  // LiveKit event wiring — every handler funnels into reconcile()
  // -------------------------------------------------------------------

  private attachRoomListeners(room: LiveKitRoomLike): void {
    room.on(RoomEvent.ParticipantConnected, () => this.reconcile());

    room.on(RoomEvent.ParticipantDisconnected, (...args: unknown[]) => {
      const participant = args[0] as LiveKitRemoteParticipantLike;
      proximityStore.getState().removePeer(participant.identity);
      this.currentGain.delete(participant.identity);
      this.reconcile();
    });

    room.on(RoomEvent.TrackPublished, () => this.reconcile());
    room.on(RoomEvent.Reconnected, () => this.reconcile());

    room.on(RoomEvent.TrackSubscribed, (...args: unknown[]) => {
      const [track, publication, participant] = args as [
        LiveKitAudioTrackLike,
        LiveKitTrackPublicationLike,
        LiveKitRemoteParticipantLike,
      ];
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.dataset.peerId = participant.identity;
      el.dataset.trackSid = publication.trackSid;
      document.body.appendChild(el);
      this.attachedElements.set(publication.trackSid, el);
    });

    room.on(RoomEvent.TrackUnsubscribed, (...args: unknown[]) => {
      const [track, publication] = args as [LiveKitAudioTrackLike, LiveKitTrackPublicationLike];
      if (track.kind !== Track.Kind.Audio) return;
      const el = this.attachedElements.get(publication.trackSid);
      if (el) {
        track.detach(el);
        el.remove();
        this.attachedElements.delete(publication.trackSid);
      }
    });

    room.on(RoomEvent.AudioPlaybackStatusChanged, () => {
      mediaStore.getState().setCanPlaybackAudio(room.canPlaybackAudio);
    });

    room.on(RoomEvent.Disconnected, () => {
      if (this.disposed) return;
      mediaStore.getState().setStatus("reconnecting");
    });
  }
}
