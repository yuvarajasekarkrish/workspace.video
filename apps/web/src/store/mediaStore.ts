import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

/**
 * Audio/media UI status — low-frequency (mic on/off, connection lifecycle,
 * autoplay-blocked state), so this is the one audio-related store React
 * components may subscribe to directly, mirroring connectionStore's role for
 * the realtime socket. Never used for per-peer gain or subscription state —
 * that is proximityStore, which is never React-subscribed.
 */
export type MediaStatus = "idle" | "connecting" | "connected" | "reconnecting" | "error";

export interface MediaState {
  status: MediaStatus;
  error: string | null;
  micEnabled: boolean;
  /** Mirrors LiveKit's `room.canPlaybackAudio` via RoomEvent.AudioPlaybackStatusChanged.
   *  False means the browser is blocking playback of already-subscribed audio
   *  despite everything being wired correctly server-side — a real, visible
   *  state, not merely the absence of one. The UI must surface a persistent
   *  "click to enable audio" affordance whenever this is false while
   *  status === "connected", not just on first load. */
  canPlaybackAudio: boolean;

  setStatus: (status: MediaStatus) => void;
  setError: (error: string | null) => void;
  setMicEnabled: (enabled: boolean) => void;
  setCanPlaybackAudio: (canPlay: boolean) => void;
  reset: () => void;
}

const initial = {
  status: "idle" as MediaStatus,
  error: null as string | null,
  micEnabled: false,
  canPlaybackAudio: false,
};

export const mediaStore = createStore<MediaState>()((set) => ({
  ...initial,
  setStatus: (status) => set({ status }),
  setError: (error) => set({ error }),
  setMicEnabled: (micEnabled) => set({ micEnabled }),
  setCanPlaybackAudio: (canPlaybackAudio) => set({ canPlaybackAudio }),
  reset: () => set(initial),
}));

export function useMediaStore<T>(selector: (state: MediaState) => T): T {
  return useStore(mediaStore, selector);
}
