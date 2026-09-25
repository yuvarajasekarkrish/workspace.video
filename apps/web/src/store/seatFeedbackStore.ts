import { createStore } from "zustand/vanilla";
import { useStore } from "zustand";

/**
 * Transient user-facing feedback for a seat request that was REFUSED —
 * occupied, a restricted zone, or no seat available (table full / nothing
 * free nearby). Mirrors zoneStore/ZoneToast's plain-store-plus-toast
 * pattern: PixiStage calls `show()` with the server's own failure reason
 * whenever sendSeatClaim/sendSeatSelect resolves `{outcome:"failed"}`, and
 * SeatFeedbackToast renders it for a few seconds. A successful claim needs
 * no entry here — the seat:update broadcast and the avatar's own teleport
 * are already the user's confirmation.
 */
export type SeatFeedbackReason =
  | "occupied"
  | "out_of_range"
  | "access_denied"
  | "not_enabled"
  | "table_full"
  | "no_seat_nearby"
  | "unknown_seat"
  | "invalid_request"
  | "not_supported"
  | "room_not_found"
  | "not_connected"
  | "unknown";

export interface SeatFeedback {
  reason: SeatFeedbackReason;
}

export interface SeatFeedbackState {
  current: SeatFeedback | null;
  show: (reason: string) => void;
  clear: () => void;
}

const KNOWN_REASONS: ReadonlySet<string> = new Set<SeatFeedbackReason>([
  "occupied",
  "out_of_range",
  "access_denied",
  "not_enabled",
  "table_full",
  "no_seat_nearby",
  "unknown_seat",
  "invalid_request",
  "not_supported",
  "room_not_found",
  "not_connected",
  "unknown",
]);

export const seatFeedbackStore = createStore<SeatFeedbackState>()((set) => ({
  current: null,
  show: (reason) => set({ current: { reason: KNOWN_REASONS.has(reason) ? (reason as SeatFeedbackReason) : "unknown" } }),
  clear: () => set({ current: null }),
}));

export function useSeatFeedback(): SeatFeedback | null {
  return useStore(seatFeedbackStore, (s) => s.current);
}
