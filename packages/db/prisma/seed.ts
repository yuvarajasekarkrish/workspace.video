/**
 * Idempotent dev seed: one workspace per plan (Phase 8), so every participant
 * limit is reachable for manual verification. Safe to re-run.
 *
 * The old "test-ws" workspace + "seed-room-1" (a hand-drawn custom map, from
 * Milestone 1's manual two-browser verification) was removed once
 * office300@1 became the sole default layout — test@example.com now lands in
 * "seed-room-startup" instead (see DevSignInForm.tsx). The custom-map-builder
 * engine itself (mapLayout.ts, roomMap.ts) is untouched — a real, separate
 * feature — this only removes the one seeded example that used it.
 */
import { prisma } from "../src/index.js";
import { PLAN_IDS, COSMIC_CAMPUS_100_ID } from "@workspace-video/shared";

async function main() {
  const userA = await prisma.user.upsert({
    where: { email: "test@example.com" },
    update: {},
    create: { email: "test@example.com", name: "Test User" },
  });

  // One workspace per plan (Phase 8), so every participant limit is reachable
  // for manual verification without touching billing/payments (there is
  // none) — just Workspace.plan set directly at seed time.
  const planWorkspaces: { slug: string; roomId: string }[] = [];
  for (const plan of PLAN_IDS) {
    const planWorkspace = await prisma.workspace.upsert({
      where: { slug: `plan-${plan}` },
      update: { plan },
      create: { name: `${plan[0]!.toUpperCase()}${plan.slice(1)} Plan Office`, slug: `plan-${plan}`, plan },
    });

    await prisma.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: planWorkspace.id, userId: userA.id } },
      update: {},
      create: { workspaceId: planWorkspace.id, userId: userA.id, role: "owner" },
    });

    const planRoomId = `seed-room-${plan}`;
    const planRoom = await prisma.room.upsert({
      where: { id: planRoomId },
      update: {},
      create: { id: planRoomId, workspaceId: planWorkspace.id, name: "Main Office" },
    });
    planWorkspaces.push({ slug: planWorkspace.slug, roomId: planRoom.id });
  }

  // A separate demo workspace for the Cosmic Campus — 100 template, on the
  // 100-person plan, so the template can be opened without touching any of
  // the per-plan rooms above (they keep the default layout).
  const cosmicWorkspace = await prisma.workspace.upsert({
    where: { slug: "cosmic-campus-demo" },
    update: {},
    create: { name: "Cosmic Campus", slug: "cosmic-campus-demo", plan: "large" },
  });
  await prisma.workspaceMember.upsert({
    where: { workspaceId_userId: { workspaceId: cosmicWorkspace.id, userId: userA.id } },
    update: {},
    create: { workspaceId: cosmicWorkspace.id, userId: userA.id, role: "owner" },
  });
  const cosmicRoom = await prisma.room.upsert({
    where: { id: "seed-room-cosmic" },
    update: {},
    create: { id: "seed-room-cosmic", workspaceId: cosmicWorkspace.id, name: "Cosmic Campus", config: { layoutId: COSMIC_CAMPUS_100_ID } },
  });

  console.log("Seeded:", {
    user: userA.email,
    planWorkspaces,
    cosmicRoom: cosmicRoom.id,
  });
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
