"use client";

import { useOccupancy } from "@/store/occupancyStore";

/** Colour state thresholds match the plan's "normal / near limit (>=80%) /
 *  full" rule — semantic state, not decoration. */
function colorFor(active: number, limit: number): string {
  if (limit <= 0) return "text-neutral-400";
  if (active >= limit) return "text-red-400";
  if (active / limit >= 0.8) return "text-amber-400";
  return "text-emerald-400";
}

/** Live "N / limit people online" — visible to everyone in the room
 *  (organiser and members alike), updated from occupancyStore, which is
 *  itself driven by peers:snapshot/occupancy:update (see RealtimeClient).
 *  Deliberately its own small component so it re-renders only on the
 *  join/leave cadence occupancyStore changes at, never on movement. */
export function OccupancyBadge() {
  const { active, limit } = useOccupancy();

  if (limit <= 0) return null; // not yet known (before the first snapshot)

  return (
    <div className="absolute left-3 top-12 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs backdrop-blur">
      <span className={`font-mono font-semibold ${colorFor(active, limit)}`}>
        {active} / {limit}
      </span>
      <span className="text-neutral-400">online</span>
    </div>
  );
}
