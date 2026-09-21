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
    <div className="w-64 max-w-full rounded-lg border border-line bg-surface p-3 text-base text-fg">
      <div className="mb-2 font-semibold text-fg-muted">In this room ({roster.length})</div>
      <ul className="space-y-1">
        {roster.map((peer) => (
          <li key={peer.userId} className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${peer.isLocal ? "bg-accent" : "bg-fg-muted"}`} />
            <span className="truncate">
              {peer.name} {peer.isLocal && <span className="text-fg-muted">(you)</span>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
