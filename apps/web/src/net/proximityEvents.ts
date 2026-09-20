import { ProximityUpdateEventSchema } from "@workspace-video/shared";
import { proximityStore } from "@/store/proximityStore";

/**
 * Handlers for the server's two proximity framings. A `proximity:update` carries
 * one peer; a `proximity:batch` carries all of a tick's peers for this listener.
 * Both go through the same per-item validation, and the batch is written to the
 * store in one step so the audio controller reconciles once per tick, not once
 * per peer.
 *
 * Extracted from RealtimeClient so they can be tested without a socket.
 */

/** Items dropped because they failed validation. Read by tests; a batch with a
 *  bad item still applies its good ones, so a drop is otherwise invisible. */
export const proximityEventStats = { droppedItems: 0 };

export function resetProximityEventStats(): void {
  proximityEventStats.droppedItems = 0;
}

/** Legacy framing: one peer per event. Returns whether it was applied. */
export function applyProximityUpdate(raw: unknown): boolean {
  const parsed = ProximityUpdateEventSchema.safeParse(raw);
  if (!parsed.success) return false;
  proximityStore.getState().setPeerProximity(parsed.data.peerId, {
    audioSubscribed: parsed.data.audioSubscribed,
    audioGain: parsed.data.audioGain,
  });
  return true;
}

/** Batched framing. Each item is validated on its own, so one malformed item
 *  costs only itself (as one malformed `proximity:update` always did), and the
 *  valid ones are applied in a single store write. A payload that is not a
 *  batch at all is ignored. */
export function applyProximityBatch(raw: unknown): { applied: number; dropped: number } {
  const updates = (raw as { updates?: unknown } | null | undefined)?.updates;
  if (!Array.isArray(updates)) return { applied: 0, dropped: 0 };

  const valid: { peerId: string; state: { audioSubscribed: boolean; audioGain: number } }[] = [];
  let dropped = 0;
  for (const item of updates) {
    const parsed = ProximityUpdateEventSchema.safeParse(item);
    if (!parsed.success) {
      dropped++;
      continue;
    }
    valid.push({
      peerId: parsed.data.peerId,
      state: { audioSubscribed: parsed.data.audioSubscribed, audioGain: parsed.data.audioGain },
    });
  }
  proximityStore.getState().setPeersProximity(valid);
  proximityEventStats.droppedItems += dropped;
  return { applied: valid.length, dropped };
}
