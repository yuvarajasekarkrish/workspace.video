import { prisma } from "./index";
import { withTransientRetry } from "./membership";
import { PLAN_PARTICIPANT_LIMITS, type ParticipantLimitProvider } from "@workspace-video/shared";

/**
 * Today's ParticipantLimitProvider implementation: reads Workspace.plan and
 * looks up its concurrent-participant limit from the shared plan table. A
 * future billing system replaces only this object — apps/realtime's
 * RoomManager and the join_room handler depend on the ParticipantLimitProvider
 * interface, not on this Prisma-backed implementation.
 */
export const planParticipantLimitProvider: ParticipantLimitProvider = {
  async getWorkspaceParticipantLimit(workspaceId: string): Promise<number> {
    const workspace = await withTransientRetry(() =>
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { plan: true },
      }),
    );
    if (!workspace) {
      throw new Error("Workspace not found.");
    }
    return PLAN_PARTICIPANT_LIMITS[workspace.plan];
  },
};
