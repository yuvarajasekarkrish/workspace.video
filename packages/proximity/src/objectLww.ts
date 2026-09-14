import type { CanvasObjectType, ObjectState } from "@cosmos/shared";

/**
 * Server-authoritative last-write-wins resolution for canvas object edits.
 * Pure, sibling to movement.ts's validateMove — same discriminated-union
 * result shape, same "return the authoritative state on rejection so the
 * caller can snap to it" contract — but deliberately NOT built on top of
 * validateMove itself: a dragged/resized object has no per-object
 * acceptedAtMs and no meaningful speed limit (a resize or a paste-in-place
 * is not a "move"), and validateMove's own docstring says teleport-style
 * repositioning must go through a separate path anyway.
 *
 * The server assigns every version; a client only ever proposes a
 * `baseVersion` (the version it last saw) and the fields it wants to set.
 * `baseVersion: 0` means "create". Everything else is edit-in-place.
 */
export interface ProposedObjectWrite {
  objectId: string;
  roomId: string;
  type: CanvasObjectType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  z: number;
  data: Record<string, unknown>;
  baseVersion: number;
}

export type ObjectWriteResult =
  | { accepted: true; next: ObjectState }
  | { accepted: false; reason: "id_collision" | "stale_version"; authoritative: ObjectState }
  /** The object no longer exists (deleted by someone else since the client
   *  last saw it) — there is no authoritative state to hand back. The
   *  caller (roomManager) should respond with the existing
   *  ServerEvents.ObjectRemoved event to the writer alone rather than
   *  object:sync, which requires a non-null `object`. */
  | { accepted: false; reason: "not_found"; authoritative: null };

/**
 * Resolves a proposed create-or-edit against the room's current in-memory
 * state for that object (`undefined` if it doesn't exist yet).
 */
export function resolveObjectWrite(
  proposed: ProposedObjectWrite,
  current: ObjectState | undefined,
  actorUserId: string,
): ObjectWriteResult {
  if (proposed.baseVersion === 0) {
    // A create. If the id already exists, this is a collision or a replay
    // of an already-accepted create — never silently overwrite someone
    // else's (or our own already-created) object.
    if (current) {
      return { accepted: false, reason: "id_collision", authoritative: current };
    }
    const next: ObjectState = {
      objectId: proposed.objectId,
      roomId: proposed.roomId,
      type: proposed.type,
      x: proposed.x,
      y: proposed.y,
      width: proposed.width,
      height: proposed.height,
      rotation: proposed.rotation,
      z: proposed.z,
      data: proposed.data,
      version: 1,
      createdById: actorUserId,
    };
    return { accepted: true, next };
  }

  // An edit against an object that's been deleted since the client last
  // saw it (e.g. someone else deleted it mid-drag) — nothing to reconcile
  // against; the caller tells the writer it's gone via ObjectRemoved.
  if (!current) {
    return { accepted: false, reason: "not_found", authoritative: null };
  }

  // The client's baseVersion must match the current authoritative version
  // exactly — anything else means it's editing against state that has
  // since changed underneath it.
  if (proposed.baseVersion !== current.version) {
    return { accepted: false, reason: "stale_version", authoritative: current };
  }

  // createdById never changes on an edit — attribution is fixed at creation.
  const next: ObjectState = {
    objectId: current.objectId,
    roomId: current.roomId,
    type: proposed.type,
    x: proposed.x,
    y: proposed.y,
    width: proposed.width,
    height: proposed.height,
    rotation: proposed.rotation,
    z: proposed.z,
    data: proposed.data,
    version: current.version + 1,
    createdById: current.createdById,
  };
  return { accepted: true, next };
}

export type ObjectDeleteOutcome =
  | { outcome: "deleted" }
  /** The object was already gone (deleted by someone else, or never
   *  existed) — treated as a successful no-op rather than an error, since
   *  the end state the caller wanted (the object doesn't exist) already
   *  holds, and there is no authoritative object to hand back for
   *  ObjectSyncEventSchema's required `object` field in this case. */
  | { outcome: "already_gone" }
  | { outcome: "rejected"; reason: "stale_version" | "not_creator"; authoritative: ObjectState };

/**
 * Resolves a proposed delete. Creator-only, per the approved plan's
 * decision — the server is the enforcement boundary, not just the UI.
 */
export function resolveObjectDelete(
  objectId: string,
  baseVersion: number,
  current: ObjectState | undefined,
  actorUserId: string,
): ObjectDeleteOutcome {
  if (!current) {
    return { outcome: "already_gone" };
  }
  if (current.createdById !== actorUserId) {
    return { outcome: "rejected", reason: "not_creator", authoritative: current };
  }
  if (baseVersion !== current.version) {
    return { outcome: "rejected", reason: "stale_version", authoritative: current };
  }
  return { outcome: "deleted" };
}
