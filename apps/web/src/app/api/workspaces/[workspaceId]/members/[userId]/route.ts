import { NextRequest } from "next/server";
import { changeMemberRole } from "@workspace-video/db";
import { WORKSPACE_ROLES, type WorkspaceRoleName } from "@workspace-video/shared";
import { getSessionUser } from "@/lib/session";
import { answer, badRequest, notSignedIn, readJsonObject } from "@/lib/layoutApi";

/**
 * Gives a workspace member a role. Body: { role }. The rules (who may give which role to whom, and that the last
 * owner is never demoted) are applied by the database function on every call; this route only says who is
 * asking (the signed-in person) and whom it is about (the address).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ workspaceId: string; userId: string }> }) {
  const { workspaceId, userId } = await params;
  const session = await getSessionUser();
  if (!session) return notSignedIn();

  const body = await readJsonObject(req);
  if (!body) return badRequest("The request must be a JSON object.");
  const role = body.role;
  if (typeof role !== "string" || !(WORKSPACE_ROLES as readonly string[]).includes(role)) {
    return badRequest(`role must be one of: ${WORKSPACE_ROLES.join(", ")}.`);
  }

  return answer(await changeMemberRole({ workspaceId, actorUserId: session.userId, targetUserId: userId, newRole: role as WorkspaceRoleName }));
}
