import { describe, it, expect, afterEach } from "vitest";
import type { WorkspaceRoleName } from "@workspace-video/shared";
import { prisma } from "../index";
import { setWorkspaceAccentPalette, setWorkspaceViewMode, getWorkspaceAppearance } from "../workspaceAppearance";

/**
 * Integration tests against the real local Postgres (same pattern as roomLayouts.test.ts). D19's
 * approved decision 2A: only an owner or admin may change how a workspace looks, checked on the
 * server every time — this proves that rule isn't silently broken by a later change, not that a
 * member would try it (the owner's own framing, 2026-09-22).
 */

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

/** A workspace with one person in each role, plus an outsider who is in none — same shape as
 *  roomLayouts.test.ts's setup(), so the two suites read the same way. */
async function setup() {
  const suffix = crypto.randomUUID();
  const workspace = await prisma.workspace.create({ data: { name: `Appearance Test ${suffix}`, slug: `appearance-test-${suffix}` } });
  workspaceIds.push(workspace.id);
  const people = {} as Record<WorkspaceRoleName | "outsider", string>;
  for (const role of ["owner", "admin", "designer", "member"] as const) {
    const user = await makeUser(role);
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role } });
    people[role] = user.id;
  }
  people.outsider = (await makeUser("outsider")).id;
  return { workspace, people };
}

describe("a new workspace keeps the file's own default (D18/D20)", () => {
  it("has no palette and no view mode until someone saves one", async () => {
    const { workspace } = await setup();
    expect(await getWorkspaceAppearance(workspace.id)).toEqual({ accentPalette: null, viewMode: null });
  });

  it("reading an unknown workspace's appearance returns null, not a thrown error", async () => {
    expect(await getWorkspaceAppearance("no-such-workspace")).toBeNull();
  });
});

describe("who may change a workspace's accent palette (D19, decision 2A)", () => {
  it("lets an owner and an admin save a palette", async () => {
    const { workspace, people } = await setup();
    expect(await setWorkspaceAccentPalette({ workspaceId: workspace.id, actorUserId: people.owner, palette: "emerald" })).toMatchObject({ ok: true, palette: "emerald" });
    expect(await setWorkspaceAccentPalette({ workspaceId: workspace.id, actorUserId: people.admin, palette: "cyan" })).toMatchObject({ ok: true, palette: "cyan" });
    expect(await getWorkspaceAppearance(workspace.id)).toMatchObject({ accentPalette: "cyan" });
  });

  it("refuses a designer and a member (forbidden), and leaves the palette unchanged", async () => {
    const { workspace, people } = await setup();
    for (const role of ["designer", "member"] as const) {
      expect(await setWorkspaceAccentPalette({ workspaceId: workspace.id, actorUserId: people[role], palette: "lime" }), role).toMatchObject({ ok: false, reason: "forbidden" });
    }
    expect(await getWorkspaceAppearance(workspace.id)).toEqual({ accentPalette: null, viewMode: null });
  });

  it("refuses an outsider with not_found, never revealing the workspace exists", async () => {
    const { workspace, people } = await setup();
    expect(await setWorkspaceAccentPalette({ workspaceId: workspace.id, actorUserId: people.outsider, palette: "lime" })).toMatchObject({ ok: false, reason: "not_found" });
  });

  it("refuses a name that is not one of the six palettes, even for an owner", async () => {
    const { workspace, people } = await setup();
    expect(await setWorkspaceAccentPalette({ workspaceId: workspace.id, actorUserId: people.owner, palette: "purple" })).toMatchObject({ ok: false, reason: "invalid" });
  });
});

describe("who may change flat vs tilted (D19/D20, the same rule as the colour)", () => {
  it("lets an owner and an admin save a view mode", async () => {
    const { workspace, people } = await setup();
    expect(await setWorkspaceViewMode({ workspaceId: workspace.id, actorUserId: people.owner, viewMode: "flat" })).toMatchObject({ ok: true, viewMode: "flat" });
    expect(await getWorkspaceAppearance(workspace.id)).toMatchObject({ viewMode: "flat" });
  });

  it("refuses a designer and a member (forbidden), and leaves the view mode unchanged", async () => {
    const { workspace, people } = await setup();
    for (const role of ["designer", "member"] as const) {
      expect(await setWorkspaceViewMode({ workspaceId: workspace.id, actorUserId: people[role], viewMode: "flat" }), role).toMatchObject({ ok: false, reason: "forbidden" });
    }
    expect(await getWorkspaceAppearance(workspace.id)).toEqual({ accentPalette: null, viewMode: null });
  });

  it("refuses a value that is not flat or tilted, even for an owner", async () => {
    const { workspace, people } = await setup();
    expect(await setWorkspaceViewMode({ workspaceId: workspace.id, actorUserId: people.owner, viewMode: "sideways" })).toMatchObject({ ok: false, reason: "invalid" });
  });
});
