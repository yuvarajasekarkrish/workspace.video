/**
 * Who may do what in a workspace, as plain functions with no database and no screens, so the rules
 * can be read and tested on their own. The server applies them on every request (never the screen
 * alone). See docs/architecture/company-map-builder.md, decision D4.
 *
 *   role        sees the live map   sees drafts and history   changes the layout   gives roles
 *   owner              yes                    yes                     yes          any role, to anyone
 *   admin              yes                    yes                     yes          member or designer only,
 *                                                                                  never to or from an admin/owner
 *   designer           yes                    yes                     yes          no
 *   member             yes                    no                      no           no
 *   (outside)          no                     no                      no           no
 *
 * The last owner can never be demoted or removed, so a workspace is never left without one.
 */

export const WORKSPACE_ROLES = ["owner", "admin", "designer", "member"] as const;
export type WorkspaceRoleName = (typeof WORKSPACE_ROLES)[number];

export type LayoutAction = "viewLive" | "viewDraftsAndHistory" | "saveDraft" | "publish" | "restore";

const EDITOR_ROLES: readonly WorkspaceRoleName[] = ["owner", "admin", "designer"];

function isRole(value: unknown): value is WorkspaceRoleName {
  return typeof value === "string" && (WORKSPACE_ROLES as readonly string[]).includes(value);
}

/** Whether a person with this role (null = not in the workspace) may do this to the layout. */
export function canDoLayoutAction(role: WorkspaceRoleName | null, action: LayoutAction): boolean {
  if (!isRole(role)) return false;
  switch (action) {
    case "viewLive":
      return true;
    case "viewDraftsAndHistory":
    case "saveDraft":
    case "publish":
    case "restore":
      return EDITOR_ROLES.includes(role);
    default:
      return false;
  }
}

export type RuleCode = "not_a_member" | "target_missing" | "unknown_role" | "forbidden" | "last_owner";
export type RuleResult = { allowed: true } | { allowed: false; code: RuleCode; reason: string };

const refuse = (code: RuleCode, reason: string): RuleResult => ({ allowed: false, code, reason });
const allow: RuleResult = { allowed: true };

export interface RoleChangeInput {
  actorRole: WorkspaceRoleName | null;
  actorIsTarget: boolean;
  targetRole: WorkspaceRoleName | null;
  newRole: WorkspaceRoleName;
  /** How many owners the workspace has right now. */
  ownerCount: number;
}

/** Whether the actor may give `newRole` to the target. */
export function checkRoleChange(input: RoleChangeInput): RuleResult {
  const { actorRole, actorIsTarget, targetRole, newRole, ownerCount } = input;
  if (!isRole(actorRole)) return refuse("not_a_member", "You are not in this workspace.");
  if (!isRole(targetRole)) return refuse("target_missing", "That person is not in this workspace.");
  if (!isRole(newRole)) return refuse("unknown_role", "That is not a role this workspace has.");
  if (actorRole !== "owner" && actorRole !== "admin") return refuse("forbidden", "Only an owner or an admin can change roles.");

  if (actorRole === "admin") {
    if (targetRole === "admin" || targetRole === "owner") {
      return refuse("forbidden", actorIsTarget ? "You cannot change your own role." : "Only an owner can change an admin or an owner.");
    }
    if (newRole === "admin" || newRole === "owner") return refuse("forbidden", "Only an owner can make someone an admin or an owner.");
  }

  if (targetRole === "owner" && newRole !== "owner" && ownerCount <= 1) {
    return refuse("last_owner", "The last owner cannot be demoted. Make someone else an owner first.");
  }
  return allow;
}

export interface RemoveMemberInput {
  actorRole: WorkspaceRoleName | null;
  actorIsTarget: boolean;
  targetRole: WorkspaceRoleName | null;
  ownerCount: number;
}

/** Whether the actor may take the target out of the workspace (or, when they are the same
 *  person, leave it). */
export function checkRemoveMember(input: RemoveMemberInput): RuleResult {
  const { actorRole, actorIsTarget, targetRole, ownerCount } = input;
  if (!isRole(actorRole)) return refuse("not_a_member", "You are not in this workspace.");
  if (!isRole(targetRole)) return refuse("target_missing", "That person is not in this workspace.");

  if (!actorIsTarget) {
    if (actorRole !== "owner" && actorRole !== "admin") return refuse("forbidden", "Only an owner or an admin can remove people.");
    if (actorRole === "admin" && (targetRole === "admin" || targetRole === "owner")) {
      return refuse("forbidden", "Only an owner can remove an admin or an owner.");
    }
  }
  if (targetRole === "owner" && ownerCount <= 1) {
    return refuse("last_owner", "The last owner cannot be removed. Make someone else an owner first.");
  }
  return allow;
}
