"use client";

import { useEffect, useRef, useState } from "react";
import { useZoneStore, type CurrentZone } from "@/store/zoneStore";

interface Message {
  title: string;
  body: string;
}

/** What actually changed about audio — not just the zone name. A meeting
 *  zone silently changing who you can hear is a correctness requirement,
 *  not polish (see the plan): without this, a user who stops hearing the
 *  room could reasonably conclude the audio is broken. */
function messageFor(current: CurrentZone | null, previous: CurrentZone | null): Message | null {
  if (current) {
    switch (current.kind) {
      case "meeting":
      case "cabin":
        return { title: `Joined ${current.label}`, body: "People outside can't hear you." };
      case "audience":
        return { title: `Joined ${current.label}`, body: "You can hear the stage clearly." };
      case "stage":
        return { title: "You're on stage", body: `${current.label} can hear you.` };
      case "focus":
        return { title: `Entered ${current.label}`, body: "Your audio is paused here." };
      default:
        return { title: `Joined ${current.label}`, body: "Open audio area." };
    }
  }
  if (previous) {
    return { title: `Left ${previous.label}`, body: "Back to nearby audio." };
  }
  return null;
}

const VISIBLE_MS = 4000;

/** Transient toast on every zone crossing. Deliberately skips the very
 *  first zone:changed a session receives (typically the spawn point, e.g.
 *  the lobby/lounge) — that's not a user action worth announcing, only an
 *  actual crossing is. */
export function ZoneToast() {
  const current = useZoneStore((s) => s.current);
  const previous = useZoneStore((s) => s.previous);
  const [message, setMessage] = useState<Message | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const skippedFirst = useRef(false);

  useEffect(() => {
    if (!skippedFirst.current) {
      skippedFirst.current = true;
      return;
    }
    const next = messageFor(current, previous);
    if (!next) return;

    setMessage(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setMessage(null), VISIBLE_MS);
  }, [current, previous]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  if (!message) return null;

  return (
    <div className="absolute left-1/2 top-16 z-40 w-80 max-w-[calc(100vw-32px)] -translate-x-1/2 rounded-lg border border-line bg-surface px-4 py-3 text-center text-base text-fg shadow-lg">
      <div className="font-semibold">{message.title}</div>
      <div className="mt-0.5 text-base text-fg-muted">{message.body}</div>
    </div>
  );
}
