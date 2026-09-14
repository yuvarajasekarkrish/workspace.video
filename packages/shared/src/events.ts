import { z } from "zod";
import { PointSchema } from "./geometry";
import { CanvasObjectTypeSchema, validateObjectData } from "./objectData";

// CanvasObjectTypeSchema/CanvasObjectType now live in objectData.ts (to avoid
// an import cycle with its per-type data validation) and are re-exported to
// package consumers via index.ts's `export * from "./objectData"` — not
// re-exported here too, since two `export *` sources for the same name
// would make it ambiguous (and silently absent) from "@cosmos/shared".

/**
 * Single source of truth for the Socket.IO protocol between apps/web and apps/realtime.
 * Every event a client can send is validated server-side against the schema here —
 * the server never trusts a client-supplied id, position, or role beyond what these
 * schemas allow. Event names are typed as literal unions so client and server can't drift.
 */

// ---------------------------------------------------------------------------
// Client -> Server
// ---------------------------------------------------------------------------

/** Sent by a client at most every 50ms while dragging/moving its own avatar. */
export const MoveEventSchema = z.object({
  position: PointSchema,
  /** Client-side timestamp (ms epoch), used only for client-side interpolation hints. */
  clientTs: z.number().finite(),
});
export type MoveEvent = z.infer<typeof MoveEventSchema>;

/** Sent once after connecting, to join a specific room. Room/user identity is NOT
 *  taken from this payload for auth purposes — the server resolves the user from the
 *  authenticated session attached at handshake, and validates the caller is a member
 *  of the workspace that owns `roomId`. */
export const JoinRoomEventSchema = z.object({
  roomId: z.string().min(1),
});
export type JoinRoomEvent = z.infer<typeof JoinRoomEventSchema>;

/** Optimistic object mutation from a client. `version` is the version the client
 *  last saw; the server rejects the write if it doesn't match current state (LWW).
 *  `data`'s shape depends on `type` (see objectData.ts) — validated here via
 *  superRefine rather than a discriminated union, since `type` and `data` are
 *  sibling fields alongside x/y/width/height/etc, not a tagged-union shape. */
export const ObjectUpsertEventSchema = z
  .object({
    objectId: z.string().min(1),
    roomId: z.string().min(1),
    type: CanvasObjectTypeSchema,
    x: z.number().finite(),
    y: z.number().finite(),
    width: z.number().finite().positive(),
    height: z.number().finite().positive(),
    rotation: z.number().finite().default(0),
    z: z.number().int().default(0),
    data: z.record(z.unknown()).default({}),
    /** Version the client is basing this write on. 0 for a brand-new object. */
    baseVersion: z.number().int().nonnegative(),
  })
  .superRefine((val, ctx) => {
    const result = validateObjectData(val.type, val.data);
    if (!result.valid) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["data"], message: result.message });
    }
  });
export type ObjectUpsertEvent = z.infer<typeof ObjectUpsertEventSchema>;

export const ObjectDeleteEventSchema = z.object({
  objectId: z.string().min(1),
  roomId: z.string().min(1),
  baseVersion: z.number().int().nonnegative(),
});
export type ObjectDeleteEvent = z.infer<typeof ObjectDeleteEventSchema>;

// ---------------------------------------------------------------------------
// Server -> Client
// ---------------------------------------------------------------------------

export const PeerSchema = z.object({
  userId: z.string().min(1),
  name: z.string(),
  avatarUrl: z.string().url().nullable(),
  position: PointSchema,
});
export type Peer = z.infer<typeof PeerSchema>;

/** Full roster, sent on join and after any resync (e.g. reconnect). */
export const PeersSnapshotEventSchema = z.object({
  roomId: z.string().min(1),
  peers: z.array(PeerSchema),
});
export type PeersSnapshotEvent = z.infer<typeof PeersSnapshotEventSchema>;

/** Batched incremental position update, emitted once per 100ms tick per room,
 *  containing only peers whose position actually changed since the last tick. */
export const PeersDeltaEventSchema = z.object({
  roomId: z.string().min(1),
  updates: z.array(
    z.object({
      userId: z.string().min(1),
      position: PointSchema,
    }),
  ),
  /** Peers who disconnected since the last tick. */
  left: z.array(z.string()).default([]),
});
export type PeersDeltaEvent = z.infer<typeof PeersDeltaEventSchema>;

/** Sent back to a client whose `move` was rejected by server-side validation
 *  (out of bounds, exceeds max speed, non-finite). The client must snap to this
 *  authoritative position rather than trusting its own predicted one. */
export const MoveCorrectionEventSchema = z.object({
  position: PointSchema,
  reason: z.enum(["out_of_bounds", "max_speed_exceeded", "invalid"]),
});
export type MoveCorrectionEvent = z.infer<typeof MoveCorrectionEventSchema>;

/** Derived proximity state between the local user and one peer, emitted only when
 *  it changes (state includes hysteresis so it does not flap at the boundary). */
export const ProximityUpdateEventSchema = z.object({
  peerId: z.string().min(1),
  audioSubscribed: z.boolean(),
  audioGain: z.number().min(0).max(1),
  videoSubscribed: z.boolean(),
});
export type ProximityUpdateEvent = z.infer<typeof ProximityUpdateEventSchema>;

export const ObjectStateSchema = z.object({
  objectId: z.string().min(1),
  roomId: z.string().min(1),
  type: CanvasObjectTypeSchema,
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  rotation: z.number().finite(),
  z: z.number().int(),
  data: z.record(z.unknown()),
  version: z.number().int().nonnegative(),
  createdById: z.string().min(1),
});
export type ObjectState = z.infer<typeof ObjectStateSchema>;

/** Authoritative object state broadcast after every accepted upsert, and also sent
 *  back to the writer alone (with objectId matching) when their write is rejected
 *  for a stale baseVersion — the client must reconcile to this state. */
export const ObjectSyncEventSchema = z.object({
  object: ObjectStateSchema,
  accepted: z.boolean(),
});
export type ObjectSyncEvent = z.infer<typeof ObjectSyncEventSchema>;

export const ObjectRemovedEventSchema = z.object({
  objectId: z.string().min(1),
  roomId: z.string().min(1),
});
export type ObjectRemovedEvent = z.infer<typeof ObjectRemovedEventSchema>;

/** Full room object list, sent on join and after any resync — the exact same
 *  wholesale-replacement role peers:snapshot plays for the roster, and for
 *  the identical reason: a stream of individual object:sync events cannot
 *  express "these are all the objects that exist, forget anything else",
 *  which is what a reconnecting client needs to avoid stale/ghost objects. */
export const ObjectsSnapshotEventSchema = z.object({
  roomId: z.string().min(1),
  objects: z.array(ObjectStateSchema),
});
export type ObjectsSnapshotEvent = z.infer<typeof ObjectsSnapshotEventSchema>;

/** Sent when this instance is no longer (or never was) authoritative for the room
 *  the client asked to join — e.g. a lease changed hands mid-connection. The client
 *  must re-resolve the room endpoint from scratch rather than retry this socket. */
export const OwnerChangedEventSchema = z.object({
  roomId: z.string().min(1),
});
export type OwnerChangedEvent = z.infer<typeof OwnerChangedEventSchema>;

// ---------------------------------------------------------------------------
// Event name constants (used as Socket.IO event names on both sides)
// ---------------------------------------------------------------------------

export const ClientEvents = {
  Move: "move",
  JoinRoom: "join_room",
  ObjectUpsert: "object:upsert",
  ObjectDelete: "object:delete",
} as const;

export const ServerEvents = {
  PeersSnapshot: "peers:snapshot",
  PeersDelta: "peers:delta",
  MoveCorrection: "move:correction",
  ProximityUpdate: "proximity:update",
  ObjectsSnapshot: "objects:snapshot",
  ObjectSync: "object:sync",
  ObjectRemoved: "object:removed",
  OwnerChanged: "owner:changed",
} as const;
