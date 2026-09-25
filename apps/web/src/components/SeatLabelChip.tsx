"use client";

import { useZoneStore } from "@/store/zoneStore";
import { useNearbySeat } from "@/store/nearbySeatStore";

/** Cosmetic-only name popup for a zone-less labeled seat (a hot-desk — see
 *  the deskGrid module, which never pushes a LayoutZone). Deliberately a
 *  separate component from ZoneHudChip, not a fallback branch inside it:
 *  this reads nothing from the server's zone system, so it can never affect
 *  zone-audio behavior or the zoneRecheckCounterparts cost that system is
 *  tuned around — see nearbySeatStore.ts's docs. Hides itself whenever a
 *  real zone chip is already showing, so the two never stack. */
export function SeatLabelChip() {
  const zone = useZoneStore((s) => s.current);
  const seat = useNearbySeat();

  if (zone || !seat) return null;

  return (
    <div className="absolute right-3 top-3 z-30 flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 text-xs backdrop-blur">
      <span className="h-2 w-2 rounded-full bg-accent" />
      <span>{seat.label}</span>
    </div>
  );
}
