import { describe, it, expect, afterEach } from "vitest";
import { SPATIAL_MAP_DEFAULT_ZONES, resolveRoomLayout, type WorkspaceRoleName } from "@workspace-video/shared";
import { prisma } from "../index";
import {
  saveLayoutVersion,
  publishLayoutVersion,
  restoreLayoutVersion,
  listLayoutVersions,
  getLayoutVersion,
  changeMemberRole,
} from "../roomLayouts";

/**
 * Integration tests against the real local Postgres (like membership.test.ts). The rules themselves
 * are tested on their own in packages/shared; these prove the database functions apply them, on every
 * call, and record who did what (docs/architecture/company-map-builder.md, D4 and D10).
 */

const starter = () => ({ version: 1, zones: SPATIAL_MAP_DEFAULT_ZONES.map((z) => ({ ...z, rect: { ...z.rect } })) });
const smaller = () => ({ version: 1, zones: [{ id: "hub", type: "hub", name: "Plaza", rect: { col: 0, row: 0, cols: 4, rows: 4 }, targetUsers: 10 }] });

const workspaceIds: string[] = [];
const userIds: string[] = [];

afterEach(async () => {
  while (workspaceIds.length) await prisma.workspace.delete({ where: { id: workspaceIds.pop()! } }).catch(() => {});
  while (userIds.length) await prisma.user.delete({ where: { id: userIds.pop()! } }).catch(() => {});
});

async function makeUser(label: string) {
  const suffix = crypto.randomUUID();
  const user = await prisma.user.create({ data: { email: `${label}-${suffix}@example.com`, name: label } });
  userIds.push(user.id);
  return user;
}

/** A workspace with one room and one person in each role, plus an outsider who is in none. */
async function setup() {
  const suffix = crypto.randomUUID();
  const workspace = await prisma.workspace.create({ data: { name: `Layout Test ${suffix}`, slug: `layout-test-${suffix}` } });
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

describe("who may save, publish, restore and read the history (every role, through the database)", () => {
  it("lets an owner, an admin and a designer save; refuses a member (forbidden) and an outsider (not found)", async () => {
    const { room, people } = await setup();
    let base = 0;
    for (const role of ["owner", "admin", "designer"] as const) {
      const result = await saveLayoutVersion({ roomId: room.id, actorUserId: people[role], map: starter(), baseVersion: base });
      expect(result, role).toMatchObject({ ok: true, version: base + 1 });
      base += 1;
    }
    expect(await saveLayoutVersion({ roomId: room.id, actorUserId: people.member, map: starter(), baseVersion: base })).toMatchObject({ ok: false, reason: "forbidden" });
    expect(await saveLayoutVersion({ roomId: room.id, actorUserId: people.outsider, map: starter(), baseVersion: base })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await prisma.roomLayoutVersion.count({ where: { roomId: room.id } })).toBe(3);
  });

  it("applies the same table to publish, restore, list and read", async () => {
    const { room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    for (const role of ["owner", "admin", "designer"] as const) {
      expect((await listLayoutVersions({ roomId: room.id, actorUserId: people[role] })).ok, `list ${role}`).toBe(true);
      expect((await getLayoutVersion({ roomId: room.id, actorUserId: people[role], version: 1 })).ok, `get ${role}`).toBe(true);
    }
    for (const role of ["member", "outsider"] as const) {
      const expected = role === "member" ? "forbidden" : "not_found";
      expect(await listLayoutVersions({ roomId: room.id, actorUserId: people[role] }), `list ${role}`).toMatchObject({ ok: false, reason: expected });
      expect(await getLayoutVersion({ roomId: room.id, actorUserId: people[role], version: 1 }), `get ${role}`).toMatchObject({ ok: false, reason: expected });
      expect(await publishLayoutVersion({ roomId: room.id, actorUserId: people[role], version: 1, expectedLiveVersion: null }), `publish ${role}`).toMatchObject({ ok: false, reason: expected });
      expect(await restoreLayoutVersion({ roomId: room.id, actorUserId: people[role], version: 1 }), `restore ${role}`).toMatchObject({ ok: false, reason: expected });
    }
    const untouched = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect((untouched.config as Record<string, unknown>).map).toBeUndefined();
  });

  it("does not tell an outsider whether a room exists", async () => {
    const { people } = await setup();
    expect(await saveLayoutVersion({ roomId: "no-such-room", actorUserId: people.owner, map: starter(), baseVersion: 0 })).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("checks the role at the moment of the call: someone demoted a moment ago is refused straight away", async () => {
    const { room, workspace, people } = await setup();
    expect((await saveLayoutVersion({ roomId: room.id, actorUserId: people.designer, map: starter(), baseVersion: 0 })).ok).toBe(true);
    await prisma.workspaceMember.update({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: people.designer } }, data: { role: "member" } });
    expect(await saveLayoutVersion({ roomId: room.id, actorUserId: people.designer, map: starter(), baseVersion: 1 })).toMatchObject({ ok: false, reason: "forbidden" });
  });
});

describe("saving a version", () => {
  it("numbers versions 1, 2, 3, stores the cleaned map, and records who saved and when", async () => {
    const { room, people } = await setup();
    const dirty = { ...starter(), evil: "x" };
    const first = await saveLayoutVersion({ roomId: room.id, actorUserId: people.admin, map: dirty, baseVersion: 0 });
    const second = await saveLayoutVersion({ roomId: room.id, actorUserId: people.designer, map: smaller(), baseVersion: 1 });
    expect(first).toMatchObject({ ok: true, version: 1 });
    expect(second).toMatchObject({ ok: true, version: 2 });
    const rows = await prisma.roomLayoutVersion.findMany({ where: { roomId: room.id }, orderBy: { version: "asc" } });
    expect(rows.map((r) => r.createdById)).toEqual([people.admin, people.designer]);
    expect(JSON.stringify(rows[0]!.map)).not.toMatch(/evil/);
    expect(rows[0]!.createdAt).toBeInstanceOf(Date);
  });

  it("refuses an invalid map with the reasons, and stores nothing", async () => {
    const { room, people } = await setup();
    const result = await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: { version: 1, zones: [] }, baseVersion: 0 });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    if (!result.ok) expect(result.errors?.join(" ")).toMatch(/at least one area/i);
    expect(await prisma.roomLayoutVersion.count({ where: { roomId: room.id } })).toBe(0);
  });

  it("refuses a save made from an old version, and says which version is current", async () => {
    const { room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.admin, map: smaller(), baseVersion: 1 });
    const stale = await saveLayoutVersion({ roomId: room.id, actorUserId: people.designer, map: starter(), baseVersion: 1 });
    expect(stale).toMatchObject({ ok: false, reason: "conflict", latestVersion: 2 });
    expect(await prisma.roomLayoutVersion.count({ where: { roomId: room.id } })).toBe(2);
  });

  it("lets only one of two saves made at the same moment from the same version win", async () => {
    const { room, people } = await setup();
    const results = await Promise.all([
      saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 }),
      saveLayoutVersion({ roomId: room.id, actorUserId: people.admin, map: smaller(), baseVersion: 0 }),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === "conflict")).toHaveLength(1);
    expect(await prisma.roomLayoutVersion.count({ where: { roomId: room.id } })).toBe(1);
  });
});

describe("publishing", () => {
  it("makes a version the room's live map, keeps the rest of the room's settings, and records who published and when", async () => {
    const { room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    const result = await publishLayoutVersion({ roomId: room.id, actorUserId: people.designer, version: 1, expectedLiveVersion: null });
    expect(result).toMatchObject({ ok: true, version: 1 });

    const live = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    const config = live.config as Record<string, unknown>;
    expect(config.layoutId).toBe("openOffice@1");
    expect(config.mapVersion).toBe(1);
    // What the realtime server and the room page read: the company's map is now the room's layout.
    const resolved = resolveRoomLayout(live.config);
    expect(resolved.source).toBe("map");
    expect(resolved.layout.seats).toHaveLength(105);

    const row = await prisma.roomLayoutVersion.findUniqueOrThrow({ where: { roomId_version: { roomId: room.id, version: 1 } } });
    expect(row.publishedById).toBe(people.designer);
    expect(row.publishedAt).toBeInstanceOf(Date);
  });

  it("refuses to publish when someone else published in the meantime, so nobody overwrites anyone", async () => {
    const { room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: smaller(), baseVersion: 1 });
    expect((await publishLayoutVersion({ roomId: room.id, actorUserId: people.owner, version: 1, expectedLiveVersion: null })).ok).toBe(true);
    // A second editor still believes nothing is live.
    const stale = await publishLayoutVersion({ roomId: room.id, actorUserId: people.admin, version: 2, expectedLiveVersion: null });
    expect(stale).toMatchObject({ ok: false, reason: "conflict", liveVersion: 1 });
    expect((await publishLayoutVersion({ roomId: room.id, actorUserId: people.admin, version: 2, expectedLiveVersion: 1 })).ok).toBe(true);
  });

  it("does not publish a version that does not exist, or one whose stored map no longer passes its checks", async () => {
    const { room, people } = await setup();
    expect(await publishLayoutVersion({ roomId: room.id, actorUserId: people.owner, version: 9, expectedLiveVersion: null })).toMatchObject({ ok: false, reason: "not_found" });
    await prisma.roomLayoutVersion.create({ data: { roomId: room.id, version: 1, map: { version: 1, zones: [] }, createdById: people.owner } });
    expect(await publishLayoutVersion({ roomId: room.id, actorUserId: people.owner, version: 1, expectedLiveVersion: null })).toMatchObject({ ok: false, reason: "invalid" });
    const untouched = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    expect((untouched.config as Record<string, unknown>).map).toBeUndefined();
  });
});

describe("restoring an earlier version", () => {
  it("saves the old map again as the newest version, with a note, and leaves every earlier version exactly as it was", async () => {
    const { room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: smaller(), baseVersion: 1 });
    const before = await prisma.roomLayoutVersion.findMany({ where: { roomId: room.id }, orderBy: { version: "asc" } });

    const result = await restoreLayoutVersion({ roomId: room.id, actorUserId: people.designer, version: 1 });
    expect(result).toMatchObject({ ok: true, version: 3 });

    const after = await prisma.roomLayoutVersion.findMany({ where: { roomId: room.id }, orderBy: { version: "asc" } });
    expect(after).toHaveLength(3);
    expect(after.slice(0, 2)).toEqual(before);
    expect(after[2]!.map).toEqual(before[0]!.map);
    expect(after[2]!.note).toMatch(/restored from version 1/i);
    expect(after[2]!.createdById).toBe(people.designer);
  });

  it("does not restore a version that does not exist", async () => {
    const { room, people } = await setup();
    expect(await restoreLayoutVersion({ roomId: room.id, actorUserId: people.owner, version: 4 })).toMatchObject({ ok: false, reason: "not_found" });
  });
});

describe("the history list", () => {
  it("shows every version newest first, who saved it, which one is live, and who published it", async () => {
    const { room, people } = await setup();
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.owner, map: starter(), baseVersion: 0 });
    await saveLayoutVersion({ roomId: room.id, actorUserId: people.admin, map: smaller(), baseVersion: 1 });
    await publishLayoutVersion({ roomId: room.id, actorUserId: people.owner, version: 1, expectedLiveVersion: null });
    const result = await listLayoutVersions({ roomId: room.id, actorUserId: people.designer });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.liveVersion).toBe(1);
    expect(result.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(result.versions[0]).toMatchObject({ createdById: people.admin, publishedAt: null });
    expect(result.versions[1]).toMatchObject({ createdById: people.owner, publishedById: people.owner });
    expect(JSON.stringify(result.versions)).not.toMatch(/"zones"/);
  });
});

describe("changing someone's role", () => {
  it("lets an owner make a member a designer, and stores it", async () => {
    const { workspace, people } = await setup();
    const result = await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.owner, targetUserId: people.member, newRole: "designer" });
    expect(result).toMatchObject({ ok: true });
    const row = await prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: people.member } } });
    expect(row.role).toBe("designer");
  });

  it("lets an admin make a member a designer, but not an admin or an owner", async () => {
    const { workspace, people } = await setup();
    expect((await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.admin, targetUserId: people.member, newRole: "designer" })).ok).toBe(true);
    for (const newRole of ["admin", "owner"] as const) {
      expect(await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.admin, targetUserId: people.designer, newRole })).toMatchObject({ ok: false, reason: "forbidden" });
    }
  });

  it("does not let a designer or a member promote anyone, including themselves", async () => {
    const { workspace, people } = await setup();
    for (const actor of ["designer", "member"] as const) {
      expect(await changeMemberRole({ workspaceId: workspace.id, actorUserId: people[actor], targetUserId: people[actor], newRole: "owner" })).toMatchObject({ ok: false, reason: "forbidden" });
      expect(await changeMemberRole({ workspaceId: workspace.id, actorUserId: people[actor], targetUserId: people.member, newRole: "designer" })).toMatchObject({ ok: false, reason: "forbidden" });
    }
    const row = await prisma.workspaceMember.findUniqueOrThrow({ where: { workspaceId_userId: { workspaceId: workspace.id, userId: people.designer } } });
    expect(row.role).toBe("designer");
  });

  it("never demotes the last owner, and treats an outsider and a stranger as not found", async () => {
    const { workspace, people } = await setup();
    expect(await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.owner, targetUserId: people.owner, newRole: "admin" })).toMatchObject({ ok: false, reason: "last_owner" });
    expect(await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.outsider, targetUserId: people.member, newRole: "designer" })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.owner, targetUserId: people.outsider, newRole: "designer" })).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("cannot be tricked into leaving a workspace with no owner by two owners demoting each other at the same moment", async () => {
    const { workspace, people } = await setup();
    await changeMemberRole({ workspaceId: workspace.id, actorUserId: people.owner, targetUserId: people.admin, newRole: "owner" });
    await Promise.all([
      changeMemberRole({ workspaceId: workspace.id, actorUserId: people.owner, targetUserId: people.admin, newRole: "member" }),
      changeMemberRole({ workspaceId: workspace.id, actorUserId: people.admin, targetUserId: people.owner, newRole: "member" }),
    ]);
    expect(await prisma.workspaceMember.count({ where: { workspaceId: workspace.id, role: "owner" } })).toBeGreaterThanOrEqual(1);
  });
});
