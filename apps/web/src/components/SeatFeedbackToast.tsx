"use client";

import { useEffect, useRef, useState } from "react";
import { useSeatFeedback, seatFeedbackStore, type SeatFeedbackReason } from "@/store/seatFeedbackStore";

const MESSAGE_FOR: Record<SeatFeedbackReason, string> = {
  occupied: "That seat is taken.",
  out_of_range: "Walk closer to sit there.",
  access_denied: "You don't have access to this area.",
  not_enabled: "This seating option isn't available here.",
  table_full: "That table is full.",
  no_seat_nearby: "No free seat nearby.",
  unknown_seat: "That seat doesn't exist.",
  invalid_request: "That seat request wasn't understood.",
  not_supported: "That seating option isn't available yet.",
  room_not_found: "That room is no longer available.",
  not_connected: "Not connected — try again in a moment.",
  unknown: "Couldn't sit there.",
};

const VISIBLE_MS = 3000;

/** Transient toast for a refused seat request (claim or select) — see
 *  seatFeedbackStore's docs. Same lifecycle shape as ZoneToast: show for
 *  VISIBLE_MS, clear on unmount. */
export function SeatFeedbackToast() {
  const feedback = useSeatFeedback();
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!feedback) return;
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      setVisible(false);
      seatFeedbackStore.getState().clear();
    }, VISIBLE_MS);
  }, [feedback]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  if (!feedback || !visible) return null;

  return (
    <div className="absolute left-1/2 top-28 z-40 w-72 -translate-x-1/2 rounded-lg bg-black/80 px-4 py-3 text-center text-sm text-white shadow-lg backdrop-blur">
      {MESSAGE_FOR[feedback.reason]}
    </div>
  );
}
