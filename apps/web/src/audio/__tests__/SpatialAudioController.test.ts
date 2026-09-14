import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { SpatialAudioController, type LiveKitRoomLike, type LiveKitRemoteParticipantLike } from "../SpatialAudioController";
import { proximityStore } from "@/store/proximityStore";
import { mediaStore } from "@/store/mediaStore";

/**
 * A hand-written fake of the narrow LiveKitRoomLike interface — there is no
 * existing socket/SDK mocking precedent in apps/web (RealtimeClient itself
 * is untested), so this establishes the pattern for imperative-shell tests
 * going forward, mirroring the fakeBroadcaster() approach already used for
 * Socket.IO in apps/realtime/src/__tests__/roomManager.test.ts.
 */
class FakeTrackPublication {
  isSubscribed = false;
  constructor(public readonly trackSid: string) {}
  setSubscribed(subscribed: boolean): void {
    this.isSubscribed = subscribed;
  }
}

class FakeRemoteParticipant implements LiveKitRemoteParticipantLike {
  audioTrackPublications = new Map<string, FakeTrackPublication>();
  volume = 0;
  constructor(public readonly identity: string) {
    this.audioTrackPublications.set(`${identity}-mic`, new FakeTrackPublication(`${identity}-mic`));
  }
  setVolume(volume: number): void {
    this.volume = volume;
  }
}

class FakeRoom implements LiveKitRoomLike {
  remoteParticipants = new Map<string, FakeRemoteParticipant>();
  localParticipant = { setMicrophoneEnabled: vi.fn().mockResolvedValue(undefined) };
  canPlaybackAudio = true;
  connected = false;
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();

  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async startAudio(): Promise<void> {}
  removeAllListeners(): void {
    this.listeners.clear();
  }
  on(event: string, handler: (...args: unknown[]) => void): this {
    const list = this.listeners.get(event) ?? [];
    list.push(handler);
    this.listeners.set(event, list);
    return this;
  }
  emit(event: string, ...args: unknown[]): void {
    for (const handler of this.listeners.get(event) ?? []) handler(...args);
  }

  /** Test helper: simulate a peer already in the room BEFORE we connect,
   *  with a published (but not yet subscribed) audio track. */
  addExistingParticipant(identity: string): FakeRemoteParticipant {
    const p = new FakeRemoteParticipant(identity);
    this.remoteParticipants.set(identity, p);
    return p;
  }
}

const fakeToken = async () => ({ token: "t", url: "ws://fake" });

describe("SpatialAudioController", () => {
  let room: FakeRoom;
  let controller: SpatialAudioController;

  beforeEach(() => {
    proximityStore.getState().clear();
    mediaStore.getState().reset();
    room = new FakeRoom();
    controller = new SpatialAudioController("room1", "local-user", fakeToken, () => room);
  });

  afterEach(async () => {
    await controller.dispose();
    vi.useRealTimers();
  });

  it("connects and reaches 'connected' status", async () => {
    await controller.connect();
    expect(mediaStore.getState().status).toBe("connected");
  });

  it("subscribes to a peer whose proximity update arrives AFTER the participant already exists (participant-before-proximity)", async () => {
    room.addExistingParticipant("peerA");
    await controller.connect();

    proximityStore.getState().setPeerProximity("peerA", { audioSubscribed: true, audioGain: 1 });

    const pub = room.remoteParticipants.get("peerA")!.audioTrackPublications.get("peerA-mic")!;
    expect(pub.isSubscribed).toBe(true);
  });

  it("subscribes to a peer whose participant connects AFTER proximity data already exists (proximity-before-participant)", async () => {
    await controller.connect();
    proximityStore.getState().setPeerProximity("peerB", { audioSubscribed: true, audioGain: 1 });

    // Peer wasn't in the room yet when the proximity update arrived —
    // nothing to subscribe to. Now they connect.
    const p = room.addExistingParticipant("peerB");
    room.emit("participantConnected", p);

    expect(p.audioTrackPublications.get("peerB-mic")!.isSubscribed).toBe(true);
  });

  it("subscribes to participants and tracks that already existed BEFORE connect() (the autoSubscribe:false sweep)", async () => {
    room.addExistingParticipant("peerC");
    // Desired state was already known before we even connected.
    proximityStore.getState().setPeerProximity("peerC", { audioSubscribed: true, audioGain: 1 });

    await controller.connect();

    // No TrackPublished event ever fires for peerC (LiveKit does not emit
    // one for tracks published before this participant joined) — only the
    // post-connect sweep inside connect() itself can have subscribed it.
    expect(room.remoteParticipants.get("peerC")!.audioTrackPublications.get("peerC-mic")!.isSubscribed).toBe(true);
  });

  it("does nothing for a peer with no proximity data yet — safe default is silence", async () => {
    room.addExistingParticipant("peerD");
    await controller.connect();
    expect(room.remoteParticipants.get("peerD")!.audioTrackPublications.get("peerD-mic")!.isSubscribed).toBe(false);
  });

  it("unsubscribes a peer once proximity marks them out of range", async () => {
    room.addExistingParticipant("peerE");
    proximityStore.getState().setPeerProximity("peerE", { audioSubscribed: true, audioGain: 1 });
    await controller.connect();
    expect(room.remoteParticipants.get("peerE")!.audioTrackPublications.get("peerE-mic")!.isSubscribed).toBe(true);

    proximityStore.getState().setPeerProximity("peerE", { audioSubscribed: false, audioGain: 0 });
    expect(room.remoteParticipants.get("peerE")!.audioTrackPublications.get("peerE-mic")!.isSubscribed).toBe(false);
  });

  it("unsubscribes and forgets a peer on ParticipantDisconnected", async () => {
    const p = room.addExistingParticipant("peerF");
    proximityStore.getState().setPeerProximity("peerF", { audioSubscribed: true, audioGain: 1 });
    await controller.connect();

    room.remoteParticipants.delete("peerF"); // LiveKit removes them from the map itself
    room.emit("participantDisconnected", p);

    expect(proximityStore.getState().desired.has("peerF")).toBe(false);
  });

  it("Reconnected re-sweeps and restores subscriptions from desired state, which was never lost", async () => {
    room.addExistingParticipant("peerG");
    proximityStore.getState().setPeerProximity("peerG", { audioSubscribed: true, audioGain: 1 });
    await controller.connect();

    const pub = room.remoteParticipants.get("peerG")!.audioTrackPublications.get("peerG-mic")!;
    pub.setSubscribed(false); // simulate the transport dropping the subscription across a reconnect
    room.emit("reconnected");

    expect(pub.isSubscribed).toBe(true);
  });

  it("reconcile is idempotent — calling it twice via redundant events changes nothing further", async () => {
    room.addExistingParticipant("peerH");
    proximityStore.getState().setPeerProximity("peerH", { audioSubscribed: true, audioGain: 1 });
    await controller.connect();

    const pub = room.remoteParticipants.get("peerH")!.audioTrackPublications.get("peerH-mic")!;
    expect(pub.isSubscribed).toBe(true);

    room.emit("trackPublished"); // redundant trigger
    expect(pub.isSubscribed).toBe(true); // unchanged, no error
  });

  it("dispose() releases the room, clears listeners, and stops the mic", async () => {
    await controller.connect();
    await controller.enableAudio();
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenCalledWith(true);

    await controller.dispose();

    expect(room.connected).toBe(false);
    expect(room.localParticipant.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);
    // dispose() deliberately does NOT reset mediaStore — see the class docs
    // on why (a StrictMode-race regression, covered below).
  });

  it("regression: a disposed StrictMode-throwaway controller's teardown must not clobber a second, live controller's status", async () => {
    // Reproduces exactly what React 19 StrictMode does in dev: RoomCanvas's
    // effect runs, is immediately cleaned up, then runs again — briefly
    // overlapping a doomed first controller's async dispose() with a real
    // second controller's connect(). Both share the same module-level
    // mediaStore singleton. This was caught during manual two-browser
    // verification: the "Enable audio" button never appeared because the
    // first controller's delayed dispose() reset status back to "idle"
    // after the second controller had already reached "connected".
    const room1 = new FakeRoom();
    const controller1 = new SpatialAudioController("room1", "local-user", fakeToken, () => room1);

    // Start connect() but don't await it yet — simulate StrictMode
    // unmounting before the first mount's async work has settled.
    const connect1 = controller1.connect();
    const dispose1 = controller1.dispose(); // overlaps with connect1, exactly as in production

    // The second, real controller mounts and connects successfully.
    await controller.connect(); // `controller`/`room` are the describe-level real instances
    expect(mediaStore.getState().status).toBe("connected");

    // Let the first controller's overlapping connect/dispose fully settle.
    await Promise.allSettled([connect1, dispose1]);

    // The real controller's status must have survived.
    expect(mediaStore.getState().status).toBe("connected");
  });

  describe("gain ramp", () => {
    beforeEach(() => vi.useFakeTimers());

    it("starts ramping on a proximity update and stops itself once converged", async () => {
      const p = room.addExistingParticipant("peerI");
      await controller.connect();

      proximityStore.getState().setPeerProximity("peerI", { audioSubscribed: true, audioGain: 1 });

      // Drive enough 50ms ticks to converge (tau=0.15s comfortably settles
      // within a couple of seconds).
      for (let i = 0; i < 100; i++) {
        await vi.advanceTimersByTimeAsync(50);
      }

      expect(p.volume).toBeCloseTo(1, 2);

      // Once converged the loop must stop scheduling itself — advancing
      // time further must not throw or keep mutating volume meaningfully.
      const volumeAfterConverge = p.volume;
      await vi.advanceTimersByTimeAsync(5000);
      expect(p.volume).toBeCloseTo(volumeAfterConverge, 6);
    });

    it("does not stack a second ramp loop when a proximity update arrives mid-ramp", async () => {
      const p = room.addExistingParticipant("peerJ");
      await controller.connect();
      proximityStore.getState().setPeerProximity("peerJ", { audioSubscribed: true, audioGain: 1 });

      await vi.advanceTimersByTimeAsync(50); // one tick in, ramp is running
      const volumeSetCallsBefore = vi.spyOn(p, "setVolume");
      // A second update arriving mid-ramp must not start a duplicate chain —
      // if it did, setVolume would be called twice per subsequent tick.
      proximityStore.getState().setPeerProximity("peerJ", { audioSubscribed: true, audioGain: 0.5 });

      await vi.advanceTimersByTimeAsync(50);
      expect(volumeSetCallsBefore).toHaveBeenCalledTimes(1);
    });

    it("clears the pending ramp timeout on dispose and does not re-arm", async () => {
      room.addExistingParticipant("peerK");
      await controller.connect();
      proximityStore.getState().setPeerProximity("peerK", { audioSubscribed: true, audioGain: 1 });
      await vi.advanceTimersByTimeAsync(50); // ramp scheduled

      await controller.dispose();

      // Nothing should throw, and no further scheduled tick should run
      // against a torn-down room — an uncaught error here would fail the test.
      await vi.advanceTimersByTimeAsync(5000);
    });
  });
});
