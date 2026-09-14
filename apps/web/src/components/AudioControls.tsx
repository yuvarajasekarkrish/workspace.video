"use client";

import { useState } from "react";
import { useMediaStore } from "@/store/mediaStore";

export interface AudioControlsProps {
  /** Bound to SpatialAudioController.enableAudio() by RoomCanvas — the
   *  imperative object itself is never exposed to React (same rule as
   *  PixiStage/RealtimeClient). Must be called from a real user click: it
   *  is what unlocks browser audio playback and prompts for the mic. */
  onEnableAudio: () => void;
  onToggleMute: (muted: boolean) => void;
}

/**
 * Subscribes only to mediaStore — low-frequency audio UI state (mic on/off,
 * connection status, whether the browser is currently blocking playback).
 * Never touches proximityStore, which updates at up to 10Hz and is read
 * only by SpatialAudioController (see the no-rerender guard in
 * components/__tests__/noRerenderAudio.test.tsx).
 */
export function AudioControls({ onEnableAudio, onToggleMute }: AudioControlsProps) {
  const status = useMediaStore((s) => s.status);
  const micEnabled = useMediaStore((s) => s.micEnabled);
  const canPlaybackAudio = useMediaStore((s) => s.canPlaybackAudio);
  const error = useMediaStore((s) => s.error);
  const [muted, setMuted] = useState(false);

  const showEnableButton = status === "connected" && (!micEnabled || !canPlaybackAudio);

  function handleEnable() {
    onEnableAudio();
  }

  function handleToggleMute() {
    const next = !muted;
    setMuted(next);
    onToggleMute(next);
  }

  return (
    <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs backdrop-blur">
      {status === "error" && error && <span className="text-red-300">Audio: {error}</span>}

      {showEnableButton && (
        <button
          type="button"
          onClick={handleEnable}
          className="rounded-full bg-emerald-600 px-3 py-1 text-white hover:bg-emerald-500"
        >
          {/* A visible, distinct label whenever playback is specifically
             blocked (rather than mic just not enabled yet) — the client
             may be correctly subscribed to every track and still silent,
             and that state must never look identical to "not connected". */}
          {micEnabled && !canPlaybackAudio ? "Click to enable audio" : "Enable audio"}
        </button>
      )}

      {micEnabled && canPlaybackAudio && (
        <button
          type="button"
          onClick={handleToggleMute}
          className="rounded-full bg-neutral-700 px-3 py-1 text-white hover:bg-neutral-600"
        >
          {muted ? "Unmute" : "Mute"}
        </button>
      )}
    </div>
  );
}
