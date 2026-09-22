import { describe, it, expect, afterEach } from "vitest";
import { SPATIAL_MAP_DEFAULT_ZONES, type WorkspaceRoleName } from "@workspace-video/shared";
import { prisma } from "../index";
import { saveLayoutVersion, publishLayoutVersion, restoreLayoutVersion, changeMemberRole, listAuditLog } from "../roomLayouts";

/**
 * Integration tests against the real local Postgres (same pattern as roomLayouts.test.ts). Task 12's
 * record table (decision 3A): one row per role change, publish or restore that actually happened —
 * never for a refused attempt, since every write sits inside the same transaction as the change
 * itself. These tests prove both halves of that: a row appears when the change succeeds, and none
 * appears when it is refused.
 */

const starter = () => ({ version: 1, zones: SPATIAL_MAP_DEFAULT_ZONES.map((z) => ({ ...z, rect: { ...z.rect } })) });

const workspaceIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  // Cascade deletes each workspace's audit rows along with it (schema.prisma's onDelete: Cascade).
  while (workspaceIds.length) await prisma.workspace.delete({ where: { id: workspaceIds.pop()! } }).catch(() => {});
  while (userIds.length) await prisma.user.delete({ where: { id: userIds.pop()! } }).catch(() => {});
});

async function makeUser(label: string) {
  const suffix = crypto.randomUUID();
  const user = await prisma.user.create({ data: { email: `${label}-${suffix}@example.com`, name: label } });
  userIds.push(user.id);
  return user;
}

/** A workspace with one room and one person in each role, plus an outsider who is in none — the
 *  same shape roomLayouts.test.ts and workspaceAppearance.test.ts use. */
async function setup() {
  const suffix = crypto.randomUUID();
  const workspace = await prisma.workspace.create({ data: { name: `Audit Test ${suffix}`, slug: `audit-test-${suffix}`, plan: "team" } });
  workspaceIds.push(workspace.id);
  const room = await prisma.room.create({ data: { workspaceId: workspace.id, name: "Main", config: { layoutId: "openOffice@1" } } });
  const people = {} as Record<WorkspaceRoleName | "outsider", string>;
  for (const role of ["owner", "admin", "designer", "member"] as const) {
    const user = await makeUser(role);
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role } });
    people[role] = user.id;
  }
  people.outsider = (await makeUser("outsider")).id;
  return { workspace, room, people };
}

describe("audit log: role changes (decision 3A)", () => {
  it("writes one row when a role change succeeds, with the old and new role", async () => {
    const { workspace, people } = await setup();
    const result = await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.owner, targetUserId: people.member, newRole: "admin" });
    expect(result.ok).toBe(true);

    const log = await listAuditLog(workspace.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({
      actorUserId: people.owner,
      action: "roleChanged",
      targetUserId: people.member,
      fromRole: "member",
      toRole: "admin",
    });
    expect(log[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("writes no row when a role change is refused (a member trying to change roles)", async () => {
    const { workspace, people } = await setup();
    const result = await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.member, targetUserId: people.designer, newRole: "admin" });
    expect(result.ok).toBe(false);
    expect(await listAuditLog(workspace.id)).toHaveLength(0);
  });

  it("writes no row when the last owner is refused a demotion", async () => {
    const { workspace, people } = await setup();
    const result = await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.owner, targetUserId: people.owner, newRole: "member" });
    expect(result.ok).toBe(false);
    expect(await listAuditLog(workspace.id)).toHaveLength(0);
  });
});

describe("audit log: publish and restore (decision 3A)", () => {
  it("writes one row when a publish succeeds, with the room and the published version", async () => {
    const { workspace, room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    const result = await publishLayoutVersion({ roomId: room.id, actorUserId: people.designer, version: 1, expectedLiveVersion: null });
    expect(result.ok).toBe(true);

    const log = await listAuditLog(workspace.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actorUserId: people.designer, action: "layoutPublished", roomId: room.id, version: 1 });
  });

  it("writes no row when a publish is refused (someone else published first)", async () => {
    const { workspace, room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    await publishLayoutVersion({ roomId: room.id, actorUserId: people.owner, version: 1, expectedLiveVersion: null });
    const stale = await publishLayoutVersion({ roomId: room.id, actorUserId: people.admin, version: 1, expectedLiveVersion: null });
    expect(stale).toMatchObject({ ok: false, reason: "conflict" });
    // One row for the successful publish above, none for the refused one.
    expect(await listAuditLog(workspace.id)).toHaveLength(1);
  });

  it("writes no row when a publish is refused for a role that may not publish", async () => {
    const { workspace, room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    const result = await publishLayoutVersion({ roomId: room.id, actorUserId: people.member, version: 1, expectedLiveVersion: null });
    expect(result).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await listAuditLog(workspace.id)).toHaveLength(0);
  });

  it("writes one row when a restore succeeds, recording the NEW version it created", async () => {
    const { workspace, room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    const result = await restoreLayoutVersion({ roomId: room.id, actorUserId: people.owner, version: 1 });
    expect(result).toMatchObject({ ok: true, version: 2 });

    const log = await listAuditLog(workspace.id);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actorUserId: people.owner, action: "layoutRestored", roomId: room.id, version: 2 });
  });

  it("writes no row when a restore is refused (that version does not exist)", async () => {
    const { workspace, room, people } = await setup();
    const result = await restoreLayoutVersion({ roomId: room.id, actorUserId: people.owner, version: 99 });
    expect(result).toMatchObject({ ok: false, reason: "not_found" });
    expect(await listAuditLog(workspace.id)).toHaveLength(0);
  });
});

describe("listAuditLog", () => {
  it("returns newest first", async () => {
    const { workspace, room, people } = await setup();
    await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.owner, targetUserId: people.member, newRole: "admin" });
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    await publishLayoutVersion({ roomId: room.id, actorUserId: people.owner, version: 1, expectedLiveVersion: null });

    const log = await listAuditLog(workspace.id);
    expect(log.map((r) => r.action)).toEqual(["layoutPublished", "roleChanged"]);
  });

  it("returns an empty list for a workspace with no history", async () => {
    const { workspace } = await setup();
    expect(await listAuditLog(workspace.id)).toEqual([]);
  });

  it("clamps an out-of-range limit instead of returning everything or nothing", async () => {
    const { workspace, people } = await setup();
    await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.owner, targetUserId: people.member, newRole: "admin" });
    expect(await listAuditLog(workspace.id, 0)).toHaveLength(1); // clamped up to 1, not 0
    expect(await listAuditLog(workspace.id, 10_000)).toHaveLength(1); // clamped down, still returns what exists
  });
});
