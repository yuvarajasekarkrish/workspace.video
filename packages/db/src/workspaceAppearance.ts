import {
  canChangeWorkspaceAppearance,
  isWorkspaceAccentPaletteId,
  isWorkspaceViewMode,
  type WorkspaceAccentPaletteId,
  type WorkspaceViewMode,
} from "@workspace-video/shared";
import { prisma } from "./index";
import { roleOf } from "./roomLayouts";

/**
 * A workspace's own look: its accent palette and whether its room is flat or tilted
 * (docs/architecture/company-map-builder.md, D18-D20). Both are checked on the server against the
 * caller's real role every time, the same as changeMemberRole and the layout routes — never trusted
 * from the screen alone (D19, decision 2A).
 */

export type AppearanceFailureReason = "not_found" | "forbidden" | "invalid";

export type AppearanceResult<T> = ({ ok: true } & T) | { ok: false; reason: AppearanceFailureReason; message: string };

const NOT_FOUND = "That workspace was not found.";
const FORBIDDEN = "Only an owner or an admin can change how the workspace looks.";

async function authorize(workspaceId: string, actorUserId: string): Promise<AppearanceResult<Record<string, never>> | { ok: true }> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { id: true } });
  if (!workspace) return { ok: false, reason: "not_found", message: NOT_FOUND };
  const role = await roleOf(prisma, workspaceId, actorUserId);
  if (role === null) return { ok: false, reason: "not_found", message: NOT_FOUND };
  if (!canChangeWorkspaceAppearance(role)) return { ok: false, reason: "forbidden", message: FORBIDDEN };
  return { ok: true };
}

export async function setWorkspaceAccentPalette(input: {
  workspaceId: string;
  actorUserId: string;
  palette: string;
}): Promise<AppearanceResult<{ palette: WorkspaceAccentPaletteId }>> {
  const { workspaceId, actorUserId, palette } = input;
  const auth = await authorize(workspaceId, actorUserId);
  if (!auth.ok) return auth;
  // The database enum would refuse a bad value too, but checking here first gives the caller a
  // plain "invalid" reason instead of a raw database error surfacing through the API route.
  if (!isWorkspaceAccentPaletteId(palette)) return { ok: false, reason: "invalid", message: "That is not one of the six palettes." };
  await prisma.workspace.update({ where: { id: workspaceId }, data: { accentPalette: palette } });
  return { ok: true, palette };
}

export async function setWorkspaceViewMode(input: {
  workspaceId: string;
  actorUserId: string;
  viewMode: string;
}): Promise<AppearanceResult<{ viewMode: WorkspaceViewMode }>> {
  const { workspaceId, actorUserId, viewMode } = input;
  const auth = await authorize(workspaceId, actorUserId);
  if (!auth.ok) return auth;
  if (!isWorkspaceViewMode(viewMode)) return { ok: false, reason: "invalid", message: "That is not flat or tilted." };
  await prisma.workspace.update({ where: { id: workspaceId }, data: { viewMode } });
  return { ok: true, viewMode };
}

/** Reading the current look is open to anyone in the workspace (it draws their own room), unlike
 *  changing it. `null` in either field means "the file's own default", per D18/D20. */
export async function getWorkspaceAppearance(
  workspaceId: string,
): Promise<{ accentPalette: WorkspaceAccentPaletteId | null; viewMode: WorkspaceViewMode | null } | null> {
  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { accentPalette: true, viewMode: true } });
  if (!workspace) return null;
  return { accentPalette: workspace.accentPalette, viewMode: workspace.viewMode };
}
