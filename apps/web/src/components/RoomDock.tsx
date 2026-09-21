"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useMediaStore } from "@/store/mediaStore";
import { useRoster, type RosterEntry } from "@/store/peersStore";
import { Icon, type IconName } from "./icons";

export interface RoomDockProps {
  /** Bound to SpatialAudioController.enableAudio() by RoomCanvas: the imperative object itself is never exposed to
   *  React (same rule as PixiStage/RealtimeClient). Must be called from a real click: it is what unlocks browser
   *  audio playback and asks for the microphone. */
  onEnableAudio: () => void;
  onToggleMute: (muted: boolean) => void;
  /** Walk the local person to where this person is standing. */
  onGoToPerson: (userId: string) => void;
}

/** People whose name contains what was typed (ignoring capital letters); everyone when nothing is typed. */
export function filterRoster(roster: RosterEntry[], query: string): RosterEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return roster;
  return roster.filter((person) => person.name.toLowerCase().includes(needle));
}

interface DockButtonProps {
  label: string;
  icon: IconName;
  onClick?: () => void;
  /** Not built yet: shown greyed out with "coming soon" so the bar already has its final shape. */
  soon?: boolean;
  disabled?: boolean;
  /** For an on/off button: whether it is currently on. */
  pressed?: boolean;
  /** Draws attention (the accent colour), for the one thing the person still needs to do, such as turning the microphone on. */
  attention?: boolean;
  danger?: boolean;
  /** Shown from tablet width up only. On a phone the bar keeps just the controls that work, so every button stays
   *  at the design notes' 48 px and the bar stays on one line. */
  tabletUp?: boolean;
}

function DockButton({ label, icon, onClick, soon, disabled, pressed, attention, danger, tabletUp }: DockButtonProps) {
  const text = soon ? `${label} (coming soon)` : label;
  const off = soon || disabled;
  const tone = off
    ? "text-fg-muted opacity-50"
    : attention
      ? "text-accent"
      : danger
        ? "text-danger hover:bg-ground"
        : "text-fg hover:bg-ground";
  return (
    <button
      type="button"
      title={text}
      aria-label={text}
      aria-pressed={pressed}
      aria-disabled={off || undefined}
      disabled={off}
      onClick={onClick}
      className={`${tabletUp ? "hidden sm:flex" : "flex"} h-12 w-12 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed ${tone}`}
    >
      <Icon name={icon} />
    </button>
  );
}

function Divider() {
  return <span aria-hidden="true" className="mx-1 h-6 w-px shrink-0 bg-line" />;
}

/**
 * The bar under the map. One line of icon-only buttons, so it never covers the floor: microphone, camera and screen
 * share on the left, then finding people, emoji, status and "invite to talk", then leave. It subscribes only to
 * low-frequency stores (mediaStore for the microphone, the roster for the people list), never to positions, so it
 * does not re-render while people walk (see the no-rerender tests).
 */
export function RoomDock({ onEnableAudio, onToggleMute, onGoToPerson }: RoomDockProps) {
  const status = useMediaStore((s) => s.status);
  const micEnabled = useMediaStore((s) => s.micEnabled);
  const canPlaybackAudio = useMediaStore((s) => s.canPlaybackAudio);
  const error = useMediaStore((s) => s.error);
  const [muted, setMuted] = useState(false);

  const audioReady = status === "connected";
  const needsEnable = audioReady && (!micEnabled || !canPlaybackAudio);

  function handleMic() {
    if (needsEnable) {
      onEnableAudio();
      return;
    }
    const next = !muted;
    setMuted(next);
    onToggleMute(next);
  }

  const micLabel = !audioReady
    ? status === "error"
      ? "Microphone unavailable"
      : "Microphone (connecting)"
    : needsEnable
      ? micEnabled && !canPlaybackAudio
        ? "Click to hear everyone"
        : "Turn on microphone"
      : muted
        ? "Unmute microphone"
        : "Mute microphone";

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 flex flex-col items-center gap-2 px-4">
      {status === "error" && error && (
        <div className="pointer-events-auto rounded-full border border-line bg-surface px-4 py-2 text-base text-danger">Audio: {error}</div>
      )}
      <PeopleSearch onGoToPerson={onGoToPerson}>
        {(searchButton) => (
          <div
            role="toolbar"
            aria-label="Room controls"
            className="pointer-events-auto flex max-w-full flex-nowrap items-center gap-0.5 overflow-x-auto rounded-full border border-line bg-surface px-2 py-1.5 shadow-lg"
          >
            <DockButton
              label={micLabel}
              icon={!needsEnable && audioReady && muted ? "micOff" : "mic"}
              onClick={handleMic}
              disabled={!audioReady}
              attention={needsEnable}
              pressed={audioReady && !needsEnable ? !muted : undefined}
            />
            <DockButton label="Camera" icon="video" soon tabletUp />
            <DockButton label="Share screen" icon="screen" soon tabletUp />
            <Divider />
            {searchButton}
            <DockButton label="Emoji" icon="smile" soon tabletUp />
            <DockButton label="Set status" icon="status" soon tabletUp />
            <DockButton label="Invite to talk" icon="talk" soon tabletUp />
            <Divider />
            <Link
              href="/"
              title="Leave room"
              aria-label="Leave room"
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-danger transition-colors hover:bg-ground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              <Icon name="leave" />
            </Link>
          </div>
        )}
      </PeopleSearch>
    </div>
  );
}

/** The find-people button and the list that opens above the bar. Escape or a click elsewhere closes it. */
function PeopleSearch({
  onGoToPerson,
  children,
}: {
  onGoToPerson: (userId: string) => void;
  children: (searchButton: React.ReactNode) => React.ReactNode;
}) {
  const roster = useRoster();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const wrapper = useRef<HTMLDivElement | null>(null);
  const shown = useMemo(() => filterRoster(roster, query), [roster, query]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      if (wrapper.current && !wrapper.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);

  function close() {
    setOpen(false);
    setQuery("");
  }

  const searchButton = (
    <DockButton
      label="Find people"
      icon="search"
      pressed={open}
      onClick={() => (open ? close() : setOpen(true))}
    />
  );

  return (
    <div ref={wrapper} className="flex flex-col items-center gap-2">
      {open && (
        <div
          role="dialog"
          aria-label="Find people"
          className="pointer-events-auto w-72 max-w-[calc(100vw-32px)] rounded-2xl border border-line bg-surface p-2 shadow-lg"
        >
          <div className="flex h-12 items-center gap-2 rounded-full border border-line bg-ground px-4 text-fg-muted">
            <Icon name="search" size={16} />
            <input
              id="people-search"
              type="search"
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Find a person"
              aria-label="Find a person"
              className="w-full bg-transparent text-base text-fg placeholder:text-fg-muted focus:outline-none"
            />
          </div>
          <ul className="mt-2 max-h-64 overflow-y-auto" aria-label="People in this room">
            {shown.map((person) => (
              <li key={person.userId}>
                <button
                  type="button"
                  disabled={person.isLocal}
                  onClick={() => {
                    onGoToPerson(person.userId);
                    close();
                  }}
                  title={person.isLocal ? "This is you" : `Walk to ${person.name}`}
                  className="flex w-full items-center gap-3 min-h-12 rounded-xl px-2 py-1.5 text-left text-base text-fg transition-colors hover:bg-ground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-default disabled:text-fg-muted disabled:hover:bg-transparent"
                >
                  <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full ${person.isLocal ? "bg-accent/20 text-accent" : "bg-line text-fg"}`}>
                    <Icon name="user" size={14} />
                  </span>
                  <span className="truncate">{person.name}</span>
                  {person.isLocal && <span className="ml-auto text-base text-fg-muted">you</span>}
                </button>
              </li>
            ))}
            {shown.length === 0 && (
              <li className="px-2 py-3 text-center text-base text-fg-muted">{roster.length <= 1 ? "No one else is here yet." : "No one matches."}</li>
            )}
          </ul>
        </div>
      )}
      {children(searchButton)}
    </div>
  );
}
