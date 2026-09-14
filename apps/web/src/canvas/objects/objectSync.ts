import type { ObjectRender } from "@/store/objectsStore";

/**
 * Decides whether an object:upsert should be sent to the server right now:
 * at most once per `throttleMs`, and only when the rect actually changed
 * since the last send. Pure — mirrors input/movement.ts's shouldEmitMove
 * exactly (explicit last-sent state rather than reading a clock or a
 * store), which is what makes drag/resize traffic debounce-friendly on the
 * server side without needing anything smarter client-side.
 */
export function shouldEmitObjectUpdate(
  lastSentAtMs: number | null,
  lastSentRect: ObjectRender | null,
  nowMs: number,
  rect: ObjectRender,
  throttleMs = 50,
): boolean {
  if (lastSentAtMs === null || lastSentRect === null) return true;

  const unchanged =
    lastSentRect.x === rect.x &&
    lastSentRect.y === rect.y &&
    lastSentRect.width === rect.width &&
    lastSentRect.height === rect.height;
  if (unchanged) return false;

  return nowMs - lastSentAtMs >= throttleMs;
}
