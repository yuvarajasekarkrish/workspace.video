import { describe, it, expect, afterEach } from "vitest";
import { prisma } from "../index";
import { planParticipantLimitProvider } from "../participantLimits";
import { PLAN_IDS, PLAN_PARTICIPANT_LIMITS, type PlanId } from "@cosmos/shared";

/**
 * Integration test against a real local Postgres, matching the precedent in
 * objects.test.ts — this module's whole job is reading Workspace.plan
 * correctly, so a mocked Prisma client wouldn't prove the migration/enum are
 * actually in sync with packages/shared's PlanId.
 */
describe("planParticipantLimitProvider", () => {
  const createdWorkspaceIds: string[] = [];

  afterEach(async () => {
    while (createdWorkspaceIds.length > 0) {
      const id = createdWorkspaceIds.pop()!;
      await prisma.workspace.delete({ where: { id } }).catch(() => {});
    }
  });

  async function createWorkspace(plan?: PlanId) {
    const suffix = crypto.randomUUID();
    const workspace = await prisma.workspace.create({
      data: {
        name: `Participant Limit Test WS ${suffix}`,
        slug: `plimit-test-${suffix}`,
        ...(plan ? { plan } : {}),
      },
    });
    createdWorkspaceIds.push(workspace.id);
    return workspace;
  }

  it("defaults a new workspace to the startup plan", async () => {
    const workspace = await createWorkspace();
    expect(workspace.plan).toBe("startup");
  });

  it.each(PLAN_IDS)("returns the correct limit for the %s plan", async (plan) => {
    const workspace = await createWorkspace(plan);
    const limit = await planParticipantLimitProvider.getWorkspaceParticipantLimit(workspace.id);
    expect(limit).toBe(PLAN_PARTICIPANT_LIMITS[plan]);
  });

  it("throws for an unknown workspace id", async () => {
    await expect(
      planParticipantLimitProvider.getWorkspaceParticipantLimit(crypto.randomUUID()),
    ).rejects.toThrow("Workspace not found.");
  });
});
