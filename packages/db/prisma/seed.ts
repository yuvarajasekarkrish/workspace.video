/**
 * Idempotent dev seed: two workspace members and one shared room, matching
 * what Milestone 1's manual two-browser verification needs. Safe to re-run.
 */
import { prisma } from "../src/index.js";

async function main() {
  const userA = await prisma.user.upsert({
    where: { email: "test@example.com" },
    update: {},
    create: { email: "test@example.com", name: "Test User" },
  });
  const userB = await prisma.user.upsert({
    where: { email: "second@example.com" },
    update: {},
    create: { email: "second@example.com", name: "Second User" },
  });

  const workspace = await prisma.workspace.upsert({
    where: { slug: "test-ws" },
    update: {},
    create: { name: "Test WS", slug: "test-ws" },
  });

  for (const [user, role] of [
    [userA, "owner"],
    [userB, "member"],
  ] as const) {
    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: user.id } },
      update: {},
      create: { workspaceId: workspace.id, userId: user.id, role },
    });
  }

  const room = await prisma.room.upsert({
    where: { id: "seed-room-1" },
    update: {},
    create: { id: "seed-room-1", workspaceId: workspace.id, name: "Main Room" },
  });

  console.log("Seeded:", {
    users: [userA.email, userB.email],
    workspace: workspace.slug,
    room: room.id,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
