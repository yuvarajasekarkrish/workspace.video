import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "../index";
import { assertRoomMembership, assertWorkspaceMembership } from "../membership";

/**
 * Integration test against a real local Postgres, matching the precedent in
 * participantLimits.test.ts and objects.test.ts. Phase 11 collapsed
 * assertRoomMembership's room lookup and membership check into a single
 * query (a nested relation filter rather than two round trips) — a mocked
 * Prisma client wouldn't prove the nested filter actually expresses the same
 * authorization rule as the original two-query version.
 */
describe("assertRoomMembership / assertWorkspaceMembership", () => {
  const createdWorkspaceIds: string[] = [];
  const createdUserIds: string[] = [];

  afterEach(async () => {
    while (createdWorkspaceIds.length > 0) {
      const id = createdWorkspaceIds.pop()!;
      await prisma.workspace.delete({ where: { id } }).catch(() => {});
    }
    while (createdUserIds.length > 0) {
      const id = createdUserIds.pop()!;
      await prisma.user.delete({ where: { id } }).catch(() => {});
    }
  });

  async function createWorkspaceWithRoom() {
    const suffix = crypto.randomUUID();
    const workspace = await prisma.workspace.create({
      data: { name: `Membership Test WS ${suffix}`, slug: `membership-test-${suffix}` },
    });
    createdWorkspaceIds.push(workspace.id);
    const room = await prisma.room.create({
      data: { workspaceId: workspace.id, name: "Test Room", config: { layoutId: "office-1" } },
    });
    return { workspace, room };
  }

  async function createMember(workspaceId: string) {
    const suffix = crypto.randomUUID();
    const user = await prisma.user.create({ data: { email: `member-${suffix}@example.com` } });
    createdUserIds.push(user.id);
    await prisma.workspaceMember.create({ data: { workspaceId, userId: user.id } });
    return user;
  }

  it("returns workspaceId and config for an actual member", async () => {
    const { workspace, room } = await createWorkspaceWithRoom();
    const member = await createMember(workspace.id);

    const result = await assertRoomMembership(member.id, room.id);
    expect(result.workspaceId).toBe(workspace.id);
    expect(result.config).toEqual({ layoutId: "office-1" });
  });

  it("rejects a user who is not a workspace member", async () => {
    const { room } = await createWorkspaceWithRoom();
    const suffix = crypto.randomUUID();
    const outsider = await prisma.user.create({ data: { email: `outsider-${suffix}@example.com` } });
    createdUserIds.push(outsider.id);

    await expect(assertRoomMembership(outsider.id, room.id)).rejects.toThrow(
      "User is not a member of this room's workspace.",
    );
  });

  it("throws for an unknown room id", async () => {
    await expect(assertRoomMembership(crypto.randomUUID(), crypto.randomUUID())).rejects.toThrow("Room not found.");
  });

  it("assertWorkspaceMembership agrees with assertRoomMembership for the same member", async () => {
    const { workspace } = await createWorkspaceWithRoom();
    const member = await createMember(workspace.id);

    await expect(assertWorkspaceMembership(member.id, workspace.id)).resolves.toBeUndefined();
  });

  it("assertWorkspaceMembership rejects a non-member", async () => {
    const { workspace } = await createWorkspaceWithRoom();
    const suffix = crypto.randomUUID();
    const outsider = await prisma.user.create({ data: { email: `outsider-${suffix}@example.com` } });
    createdUserIds.push(outsider.id);

    await expect(assertWorkspaceMembership(outsider.id, workspace.id)).rejects.toThrow(
      "User is not a member of this room's workspace.",
    );
  });
});
