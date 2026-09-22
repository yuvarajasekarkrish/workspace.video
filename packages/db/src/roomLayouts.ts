import { Prisma } from "@prisma/client";
import {
  canDoLayoutAction,
  canUseMapBuilder,
  checkRoleChange,
  validateRoomMap,
  type LayoutAction,
  type WorkspaceRoleName,
} from "@workspace-video/shared";
import { prisma } from "./index";
import { withTransientRetry } from "./membership";

/**
 * Saving, publishing, restoring and reading the history of a room's map, and giving roles. Every
 * function looks up the person's REAL role at that moment and applies the rules from
 * packages/shared/src/permissions.ts before it does anything, so no caller (a route, a script, a
 * test) can skip them. See docs/architecture/company-map-builder.md, D4 and D10.
 *
 * The model, in one picture:
 *
 *   save   ─► RoomLayoutVersion v1, v2, v3 ...   (rows are only ever added, never edited or deleted)
 *   publish ─► copies one version's map into Room.config.map and Room.config.mapVersion
 *              (the realtime server and the room page read ONLY Room.config, as before)
 *   restore ─► saves an old version's map again as the newest version
 *
 * A published map takes effect the next time the room is empty, because the server keeps a room's
 * layout for as long as anyone is inside it (decision D5).
 */

export type LayoutFailureReason = "forbidden" | "not_found" | "invalid" | "conflict" | "plan_required";

export interface LayoutFailure {
  ok: false;
  reason: LayoutFailureReason;
  message: string;
  /** For "invalid": every problem found, in plain words. */
  errors?: string[];
  /** For a refused save: the newest saved version number right now. */
  latestVersion?: number;
  /** For a refused publish: the version that is live right now (null = none). */
  liveVersion?: number | null;
}

const fail = (reason: LayoutFailureReason, message: string, extra: Partial<LayoutFailure> = {}): LayoutFailure => ({
  ok: false,
  reason,
  message,
  ...extra,
});

// A person who is not in the workspace is told "not found", never "forbidden", so the answer does
// not reveal whether a room exists.
const NOT_FOUND = "That room was not found.";
const PLAN_REQUIRED_MESSAGE = "Your plan does not include the map builder. Choose a ready-made template instead.";

type Db = Prisma.TransactionClient | typeof prisma;

/** Exported so other files that need a member's real role (e.g. workspaceAppearance.ts) reuse this
 *  one lookup instead of writing their own copy. */
export async function roleOf(db: Db, workspaceId: string, userId: string): Promise<WorkspaceRoleName | null> {
  const member = await db.workspaceMember.findUnique({ where: { workspaceId_userId: { workspaceId, userId } }, select: { role: true } });
  return member?.role ?? null;
}

async function authorizeRoom(db: Db, roomId: string, actorUserId: string, action: LayoutAction) {
  const room = await db.room.findUnique({ where: { id: roomId }, select: { id: true, workspaceId: true, config: true } });
  if (!room) return fail("not_found", NOT_FOUND);
  const role = await roleOf(db, room.workspaceId, actorUserId);
  if (role === null) return fail("not_found", NOT_FOUND);
  if (!canDoLayoutAction(role, action)) return fail("forbidden", "Only an owner, an admin or a designer can do that.");
  // The plan is checked AFTER the role, so nobody outside the right roles learns anything about the plan. Reading the
  // live map and the history stays open on every plan, so a workspace that moves to a smaller plan keeps its map,
  // can still see its history, and is only locked out of changing it (decision 1A of the design review).
  if (action === "saveDraft" || action === "publish" || action === "restore") {
    const workspace = await db.workspace.findUnique({ where: { id: room.workspaceId }, select: { plan: true } });
    if (!workspace || !canUseMapBuilder(workspace.plan)) return fail("plan_required", PLAN_REQUIRED_MESSAGE);
  }
  return { ok: true as const, room, role };
}

function plainObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The version number that is live in this room's settings, or null when none has been published. */
function liveVersionOf(config: unknown): number | null {
  const v = plainObject(config).mapVersion;
  return typeof v === "number" && Number.isInteger(v) ? v : null;
}

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

async function latestVersionOf(db: Db, roomId: string): Promise<number> {
  const result = await db.roomLayoutVersion.aggregate({ where: { roomId }, _max: { version: true } });
  return result._max.version ?? 0;
}

export type SaveResult = { ok: true; version: number } | LayoutFailure;

/** Saves a map as a new version. `baseVersion` is the newest version the editor started from (0 when
 *  there is none); a save made from an older one is refused, so nobody overwrites anyone. */
export async function saveLayoutVersion(input: {
  roomId: string;
  actorUserId: string;
  map: unknown;
  baseVersion: number;
  note?: string;
}): Promise<SaveResult> {
  const { roomId, actorUserId, map, baseVersion, note } = input;
  return withTransientRetry(async () => {
    const auth = await authorizeRoom(prisma, roomId, actorUserId, "saveDraft");
    if (!auth.ok) return auth;
    if (!Number.isInteger(baseVersion) || baseVersion < 0) return fail("invalid", "The starting version is not valid.", { errors: ["baseVersion must be a whole number, 0 or more"] });

    const checked = validateRoomMap(map);
    if (!checked.ok) return fail("invalid", "The map did not pass its checks.", { errors: checked.errors });

    try {
      return await prisma.$transaction(async (tx): Promise<SaveResult> => {
        const latest = await latestVersionOf(tx, roomId);
        if (latest !== baseVersion) return fail("conflict", "Someone saved a newer version first.", { latestVersion: latest });
        const row = await tx.roomLayoutVersion.create({
          data: { roomId, version: latest + 1, map: checked.map as unknown as Prisma.InputJsonValue, createdById: actorUserId, note: note ?? null },
        });
        return { ok: true, version: row.version };
      });
    } catch (err) {
      // Two saves at the same moment from the same version: the database allows only one row per
      // version number, so the second one lands here.
      if (isUniqueViolation(err)) return fail("conflict", "Someone saved a newer version first.", { latestVersion: await latestVersionOf(prisma, roomId) });
      throw err;
    }
  });
}

export type PublishResult = { ok: true; version: number } | LayoutFailure;

/** Makes a saved version the room's live map. `expectedLiveVersion` is the live version the editor saw
 *  (null = none); if someone published in the meantime the publish is refused. */
export async function publishLayoutVersion(input: {
  roomId: string;
  actorUserId: string;
  version: number;
  expectedLiveVersion: number | null;
}): Promise<PublishResult> {
  const { roomId, actorUserId, version, expectedLiveVersion } = input;
  return withTransientRetry(async () => {
    const auth = await authorizeRoom(prisma, roomId, actorUserId, "publish");
    if (!auth.ok) return auth;

    const row = await prisma.roomLayoutVersion.findUnique({ where: { roomId_version: { roomId, version } } });
    if (!row) return fail("not_found", "That version does not exist.");
    // Checked again on the way out of storage, not only when it went in.
    const checked = validateRoomMap(row.map);
    if (!checked.ok) return fail("invalid", "That version no longer passes its checks, so it was not published.", { errors: checked.errors });

    return prisma.$transaction(async (tx): Promise<PublishResult> => {
      // Lock this room's row so two publishes cannot both read "nothing live" and both win.
      await tx.$queryRaw`SELECT id FROM rooms WHERE id = ${roomId} FOR UPDATE`;
      const room = await tx.room.findUniqueOrThrow({ where: { id: roomId }, select: { config: true } });
      const live = liveVersionOf(room.config);
      if (live !== expectedLiveVersion) return fail("conflict", "Someone published a different version first.", { liveVersion: live });

      const config = { ...plainObject(room.config), map: checked.map, mapVersion: version };
      await tx.room.update({ where: { id: roomId }, data: { config: config as unknown as Prisma.InputJsonValue } });
      await tx.roomLayoutVersion.update({ where: { id: row.id }, data: { publishedById: actorUserId, publishedAt: new Date() } });
      return { ok: true, version };
    });
  });
}

/** Saves an earlier version's map again as the newest version. Nothing already saved is changed. */
export async function restoreLayoutVersion(input: { roomId: string; actorUserId: string; version: number }): Promise<SaveResult> {
  const { roomId, actorUserId, version } = input;
  return withTransientRetry(async () => {
    const auth = await authorizeRoom(prisma, roomId, actorUserId, "restore");
    if (!auth.ok) return auth;
    const old = await prisma.roomLayoutVersion.findUnique({ where: { roomId_version: { roomId, version } } });
    if (!old) return fail("not_found", "That version does not exist.");
    const checked = validateRoomMap(old.map);
    if (!checked.ok) return fail("invalid", "That version no longer passes its checks, so it cannot be restored.", { errors: checked.errors });

    // Appending after the newest version can race with another save; retry a few times.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await prisma.$transaction(async (tx): Promise<SaveResult> => {
          const latest = await latestVersionOf(tx, roomId);
          const row = await tx.roomLayoutVersion.create({
            data: { roomId, version: latest + 1, map: checked.map as unknown as Prisma.InputJsonValue, createdById: actorUserId, note: `Restored from version ${version}` },
          });
          return { ok: true, version: row.version };
        });
      } catch (err) {
        if (!isUniqueViolation(err)) throw err;
      }
    }
    return fail("conflict", "Other saves kept arriving. Please try again.", { latestVersion: await latestVersionOf(prisma, roomId) });
  });
}

export interface LayoutVersionSummary {
  version: number;
  createdById: string;
  createdAt: Date;
  note: string | null;
  publishedById: string | null;
  publishedAt: Date | null;
}

export type ListResult = { ok: true; liveVersion: number | null; versions: LayoutVersionSummary[] } | LayoutFailure;

/** The history, newest first, without the maps themselves. Editors only. */
export async function listLayoutVersions(input: { roomId: string; actorUserId: string }): Promise<ListResult> {
  const { roomId, actorUserId } = input;
  return withTransientRetry(async () => {
    const auth = await authorizeRoom(prisma, roomId, actorUserId, "viewDraftsAndHistory");
    if (!auth.ok) return auth;
    const versions = await prisma.roomLayoutVersion.findMany({
      where: { roomId },
      orderBy: { version: "desc" },
      select: { version: true, createdById: true, createdAt: true, note: true, publishedById: true, publishedAt: true },
    });
    return { ok: true, liveVersion: liveVersionOf(auth.room.config), versions };
  });
}

export type GetResult = { ok: true; version: number; map: unknown; createdById: string; createdAt: Date; note: string | null } | LayoutFailure;

/** One saved version with its map, for opening it in the builder. Editors only. */
export async function getLayoutVersion(input: { roomId: string; actorUserId: string; version: number }): Promise<GetResult> {
  const { roomId, actorUserId, version } = input;
  return withTransientRetry(async () => {
    const auth = await authorizeRoom(prisma, roomId, actorUserId, "viewDraftsAndHistory");
    if (!auth.ok) return auth;
    const row = await prisma.roomLayoutVersion.findUnique({ where: { roomId_version: { roomId, version } } });
    if (!row) return fail("not_found", "That version does not exist.");
    return { ok: true, version: row.version, map: row.map, createdById: row.createdById, createdAt: row.createdAt, note: row.note };
  });
}

export type RoleChangeReason = "forbidden" | "not_found" | "invalid" | "last_owner";
export type RoleChangeResult = { ok: true; role: WorkspaceRoleName } | { ok: false; reason: RoleChangeReason; message: string };

/** Gives `newRole` to a member of the workspace, if the rules allow it. The membership rows of the
 *  workspace are locked while the rule is checked and the change written, so two changes made at the
 *  same moment cannot both pass a check that only one of them should (for example, two owners
 *  demoting each other, which would leave no owner). */
export async function changeMemberRole(input: {
  workspaceId: string;
  actorUserId: string;
  targetUserId: string;
  newRole: WorkspaceRoleName;
}): Promise<RoleChangeResult> {
  const { workspaceId, actorUserId, targetUserId, newRole } = input;
  return withTransientRetry(() =>
    prisma.$transaction(async (tx): Promise<RoleChangeResult> => {
      await tx.$queryRaw`SELECT id FROM workspace_members WHERE "workspaceId" = ${workspaceId} ORDER BY id FOR UPDATE`;
      const actorRole = await roleOf(tx, workspaceId, actorUserId);
      const targetRole = await roleOf(tx, workspaceId, targetUserId);
      const ownerCount = await tx.workspaceMember.count({ where: { workspaceId, role: "owner" } });

      const verdict = checkRoleChange({ actorRole, actorIsTarget: actorUserId === targetUserId, targetRole, newRole, ownerCount });
      if (!verdict.allowed) {
        const reason: RoleChangeReason =
          verdict.code === "not_a_member" || verdict.code === "target_missing"
            ? "not_found"
            : verdict.code === "unknown_role"
              ? "invalid"
              : verdict.code;
        return { ok: false, reason, message: verdict.reason };
      }
      await tx.workspaceMember.update({ where: { workspaceId_userId: { workspaceId, userId: targetUserId } }, data: { role: newRole } });
      return { ok: true, role: newRole };
    }),
  );
}
