"use client";

import { useRoster } from "@/store/peersStore";

/**
 * Renders the participant list via useRoster() (store/peersStore.ts), which
 * is built specifically so this component re-renders on roster membership
 * changes only — never on the ~10Hz position traffic a naive subscription
 * to the raw peers map would pick up.
 */
export function RoomHud() {
  const roster = useRoster();

  return (
    <div className="absolute right-3 top-16 w-48 rounded-lg bg-black/50 p-3 text-xs backdrop-blur">
      <div className="mb-2 font-semibold text-neutral-300">In this room ({roster.length})</div>
      <ul className="space-y-1">
        {roster.map((peer) => (
          <li key={peer.userId} className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${peer.isLocal ? "bg-accent" : "bg-slate-500"}`} />
            <span className="truncate">
              {peer.name} {peer.isLocal && <span className="text-neutral-500">(you)</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
