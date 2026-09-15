import { prisma } from "@cosmos/db";
import { DEFAULT_LAYOUT_ID } from "@cosmos/shared";

export interface LoadHarnessWorkspace {
  workspaceId: string;
  roomId: string;
  users: { id: string; email: string }[];
}

/** Throwaway Enterprise workspace with n + 1 members (the spare one attempts
 *  the limit+1 join) and one default-layout room. Runs server-side so the
 *  load generator never needs database access. */
export async function provisionLoadHarnessWorkspace(n: number): Promise<LoadHarnessWorkspace> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const workspace = await prisma.workspace.create({
    data: { name: `Load Harness ${n} ${suffix}`, slug: `load-harness-${n}-${suffix}`, plan: "enterprise" },
  });

  const users: { id: string; email: string }[] = [];
  for (let i = 0; i < n + 1; i++) {
    const email = `load-harness-${suffix}-${i}@example.com`;
    const user = await prisma.user.create({ data: { email, name: `Load ${i}` } });
    await prisma.workspaceMember.create({ data: { workspaceId: workspace.id, userId: user.id, role: "member" } });
    users.push({ id: user.id, email });
  }

  const room = await prisma.room.create({
    data: { workspaceId: workspace.id, name: "Load Harness Office", config: { layoutId: DEFAULT_LAYOUT_ID } },
  });

  return { workspaceId: workspace.id, roomId: room.id, users };
}

export async function teardownLoadHarnessWorkspace(workspaceId: string, userIds: string[]): Promise<void> {
  // Room and membership rows cascade from the workspace delete.
  await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
}
