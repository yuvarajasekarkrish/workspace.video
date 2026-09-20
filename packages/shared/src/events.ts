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
  /** Opt-in: this connection understands `proximity:batch`. Absent means it does
   *  not, and it keeps receiving one `proximity:update` per change. It belongs to
   *  the connection that sent this join, not to the user: the server keeps it on
   *  the peer record next to the socket id, so a reconnect re-declares it. */
  proximityBatch: z.boolean().optional(),
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

/** Claims a hot-desk seat by id. The server validates existence, occupancy,
 *  and proximity against its own last-accepted position for this peer —
 *  never a client-supplied point, or "sitting" would be a free teleport
 *  (see packages/proximity/src/seatOccupancy.ts). */
export const SeatClaimEventSchema = z.object({
  seatId: z.string().min(1),
});
export type SeatClaimEvent = z.infer<typeof SeatClaimEventSchema>;

/** Releases whichever seat the sender currently occupies. Idempotent — a
 *  release with no seat held is a harmless no-op, which is what makes the
 *  optimistic-stand-up / implicit-release-on-move race safe (see the plan's
 *  "Ordering: seat:release vs. the first move"). */
export const SeatReleaseEventSchema = z.object({});
export type SeatReleaseEvent = z.infer<typeof SeatReleaseEventSchema>;

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

/** Full roster, sent on join and after any resync (e.g. reconnect). Carries
 *  the workspace's current occupancy alongside the roster so a freshly
 *  joined client has both without waiting for a separate event — existing
 *  clients also receive this on every join, which is what keeps their
 *  occupancy display current without a dedicated broadcast on the join
 *  path (see OccupancyUpdateEventSchema below, used for the leave path,
 *  where no snapshot is otherwise sent). */
export const PeersSnapshotEventSchema = z.object({
  roomId: z.string().min(1),
  peers: z.array(PeerSchema),
  active: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type PeersSnapshotEvent = z.infer<typeof PeersSnapshotEventSchema>;

/** Broadcast whenever a workspace's active-participant count changes
 *  (join or leave) — the join path also refreshes this via
 *  PeersSnapshotEventSchema's active/limit fields, but a leave only emits
 *  peers:delta (which carries no occupancy), so this is what keeps
 *  occupancy displays current for everyone still in the room after someone
 *  departs. */
export const OccupancyUpdateEventSchema = z.object({
  roomId: z.string().min(1),
  active: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
});
export type OccupancyUpdateEvent = z.infer<typeof OccupancyUpdateEventSchema>;

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

/** All of one listener's proximity changes for a tick in a single event. Each
 *  item is exactly a `proximity:update` payload, so the two formats carry the
 *  same information; only the framing differs. Sent only to connections that
 *  opted in via `JoinRoomEvent.proximityBatch`. */
export const ProximityBatchEventSchema = z.object({
  updates: z.array(ProximityUpdateEventSchema),
});
export type ProximityBatchEvent = z.infer<typeof ProximityBatchEventSchema>;

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

/** Full seat occupancy, sent only to the joining/reconnecting socket — the
 *  same wholesale-replacement role objects:snapshot plays, and for the
 *  identical reason: an existing peer's knowledge of who's seated where
 *  doesn't change just because someone else joined. */
export const SeatsSnapshotEventSchema = z.object({
  roomId: z.string().min(1),
  occupancy: z.array(z.object({ seatId: z.string().min(1), userId: z.string().min(1) })),
});
export type SeatsSnapshotEvent = z.infer<typeof SeatsSnapshotEventSchema>;

/** Broadcast to the whole room on every occupancy change (claim, release, or
 *  an implicit release from a move) — `userId: null` means the seat is now
 *  free. */
export const SeatUpdateEventSchema = z.object({
  seatId: z.string().min(1),
  userId: z.string().min(1).nullable(),
});
export type SeatUpdateEvent = z.infer<typeof SeatUpdateEventSchema>;

/** Sent to a single peer's own socket whenever THEIR zone membership
 *  changes (entering or leaving a meeting room, cabin, stage, audience,
 *  open area, or focus zone) — never broadcast, since it's about what that
 *  one peer just experienced. `zone: null` means they left every zone.
 *  Drives the zone UX toast/HUD chip; a meeting zone silently changing who
 *  you can hear is a correctness requirement, not polish (see the plan). */
export const ZoneChangedEventSchema = z.object({
  zone: z
    .object({
      id: z.string().min(1),
      label: z.string(),
      kind: z.enum(["meeting", "cabin", "stage", "audience", "open", "focus", "lobby"]),
    })
    .nullable(),
});
export type ZoneChangedEvent = z.infer<typeof ZoneChangedEventSchema>;

// ---------------------------------------------------------------------------
// Event name constants (used as Socket.IO event names on both sides)
// ---------------------------------------------------------------------------

export const ClientEvents = {
  Move: "move",
  JoinRoom: "join_room",
  ObjectUpsert: "object:upsert",
  ObjectDelete: "object:delete",
  SeatClaim: "seat:claim",
  SeatRelease: "seat:release",
} as const;

export const ServerEvents = {
  PeersSnapshot: "peers:snapshot",
  PeersDelta: "peers:delta",
  MoveCorrection: "move:correction",
  ProximityUpdate: "proximity:update",
  ProximityBatch: "proximity:batch",
  ObjectsSnapshot: "objects:snapshot",
  ObjectSync: "object:sync",
  ObjectRemoved: "object:removed",
  OwnerChanged: "owner:changed",
  OccupancyUpdate: "occupancy:update",
  SeatsSnapshot: "seats:snapshot",
  SeatUpdate: "seat:update",
  ZoneChanged: "zone:changed",
} as const;
