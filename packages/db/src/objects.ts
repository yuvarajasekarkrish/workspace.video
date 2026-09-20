import { prisma } from "./index";
import { withTransientRetry } from "./membership";
import type { ObjectState } from "@workspace-video/shared";
import type { CanvasObject, Prisma } from "@prisma/client";

/**
 * Repository for `canvas_objects`. Used exclusively by the realtime
 * server's debounced flush path (apps/realtime/src/objectPersistence.ts) —
 * never called from the per-drag-event hot path. See the approved plan's
 * persistence invariant: one drag gesture produces exactly one durable
 * write, not one per socket emit.
 *
 * The realtime server's in-memory RoomManager state is the sole source of
 * truth for conflict resolution (see packages/proximity/src/objectLww.ts);
 * this module is a plain write-behind mirror of whatever RoomManager has
 * already decided, so none of these functions do their own version
 * checking — a stale write here would be a bug in the caller, not something
 * this layer should try to detect.
 */

function toObjectState(row: CanvasObject): ObjectState {
  return {
    objectId: row.id,
    roomId: row.roomId,
    type: row.type,
    x: row.x,
    y: row.y,
    width: row.width,
    height: row.height,
    rotation: row.rotation,
    z: row.z,
    data: row.data as Record<string, unknown>,
    version: row.version,
    createdById: row.createdById,
  };
}

/** Loads every object currently persisted for a room — called once when a
 *  room is hydrated into memory (on first join after the room has no live
 *  instance), never on a hot path. */
export async function loadRoomObjects(roomId: string): Promise<ObjectState[]> {
  const rows = await withTransientRetry(() =>
    prisma.canvasObject.findMany({ where: { roomId } }),
  );
  return rows.map(toObjectState);
}

/** Writes the authoritative state of one object, creating it if it doesn't
 *  exist yet. The caller (objectPersistence.ts) always reads the latest
 *  in-memory state immediately before calling this, so a burst of edits to
 *  the same object collapses into a single call with the final value. */
export async function upsertObject(state: ObjectState): Promise<void> {
  const data: Prisma.CanvasObjectUncheckedCreateInput = {
    id: state.objectId,
    roomId: state.roomId,
    type: state.type,
    x: state.x,
    y: state.y,
    width: state.width,
    height: state.height,
    rotation: state.rotation,
    z: state.z,
    data: state.data as Prisma.InputJsonValue,
    version: state.version,
    createdById: state.createdById,
  };

  await withTransientRetry(() =>
    prisma.canvasObject.upsert({
      where: { id: state.objectId },
      create: data,
      update: data,
    }),
  );
}

/** Deletes one object. Tolerates the row already being gone (P2025) — the
 *  flush path can race with a room being torn down, and "already deleted"
 *  is exactly the outcome a delete wants, not an error. */
export async function deleteObject(objectId: string): Promise<void> {
  await withTransientRetry(async () => {
    const { count } = await prisma.canvasObject.deleteMany({ where: { id: objectId } });
    return count;
  });
}
