"use client";

import { useEffect, useState } from "react";
import { zoneAt, type RoomLayout } from "@workspace-video/shared";
import { useZoneStore } from "@/store/zoneStore";
import { peersStore, useRoster } from "@/store/peersStore";

export interface ZoneHudChipProps {
  /** The room's layout itself, decided on the room page (a company's own map has no name to look up). */
  layout: RoomLayout;
}

/** Persistent chip while inside a zone — the plan requires this be
 *  discoverable at any moment, not only at the instant of crossing (that's
 *  ZoneToast's job). The live occupant count is deliberately computed on
 *  human-timescale triggers only (this zone changing, or roster membership
 *  changing) — reading peersStore.getState() imperatively inside an effect,
 *  never a per-frame subscription, so this never re-renders on movement. */
export function ZoneHudChip({ layout }: ZoneHudChipProps) {
  const zone = useZoneStore((s) => s.current);
  const roster = useRoster(); // stable reference; only changes on join/leave
  const [count, setCount] = useState(0);

  useEffect(() => {
    if (!zone) return;

    let n = 0;
    for (const peer of peersStore.getState().peers.values()) {
      if (zoneAt(layout, peer.position)?.id === zone.id) n++;
    }
    setCount(n);
    // `roster` is intentionally a dependency: it's the human-timescale
    // signal that someone joined/left and the count might be stale, even
    // though the count itself is read from live positions, not from roster.
  }, [zone, roster, layout]);

  if (!zone) return null;

  const capacity = layout.zones.find((z) => z.id === zone.id)?.capacity;

  return (
    <div className="absolute right-3 top-3 z-30 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs backdrop-blur">
      <span className="h-2 w-2 rounded-full bg-accent" />
      <span>{zone.label}</span>
      {typeof capacity === "number" && (
        <span className="font-mono text-neutral-300">
          {count}/{capacity}
        </span>
      )}
    </div>
  );
}
