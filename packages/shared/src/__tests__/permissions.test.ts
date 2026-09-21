import { describe, it, expect } from "vitest";
import {
  WORKSPACE_ROLES,
  canDoLayoutAction,
  checkRoleChange,
  checkRemoveMember,
  type LayoutAction,
  type WorkspaceRoleName,
} from "../permissions";

// The strict rules from docs/architecture/company-map-builder.md (D4), as one table you can read.
// Roles: owner, admin, designer (may change the layout and nothing else), member (sees the map).
// null = not in the workspace at all.

type Role = WorkspaceRoleName | null;
const ACTIONS: LayoutAction[] = ["viewLive", "viewDraftsAndHistory", "saveDraft", "publish", "restore"];

//                     viewLive  drafts&history  saveDraft  publish  restore
const TABLE: Record<string, boolean[]> = {
  null: [false, false, false, false, false],
  member: [true, false, false, false, false],
  designer: [true, true, true, true, true],
  admin: [true, true, true, true, true],
  owner: [true, true, true, true, true],
};

describe("canDoLayoutAction: who may do what to the layout", () => {
  for (const role of [null, ...WORKSPACE_ROLES] as Role[]) {
    ACTIONS.forEach((action, i) => {
      const expected = TABLE[String(role)]![i]!;
      it(`${role ?? "someone outside the workspace"} ${expected ? "may" : "may not"} ${action}`, () => {
        expect(canDoLayoutAction(role, action)).toBe(expected);
      });
    });
  }

  it("refuses a role name it does not know, and an action it does not know", () => {
    expect(canDoLayoutAction("superuser" as never, "saveDraft")).toBe(false);
    expect(canDoLayoutAction("owner", "deleteEverything" as never)).toBe(false);
  });
});

const change = (over: Partial<Parameters<typeof checkRoleChange>[0]> = {}) =>
  checkRoleChange({ actorRole: "owner", actorIsTarget: false, targetRole: "member", newRole: "designer", ownerCount: 1, ...over });

describe("checkRoleChange: who may give a role to whom", () => {
  it("lets an owner give any role to anyone", () => {
    for (const target of WORKSPACE_ROLES) {
      for (const next of WORKSPACE_ROLES) {
        // The one exception is demoting the only owner, covered below.
        const result = change({ targetRole: target, newRole: next, ownerCount: 2 });
        expect(result.allowed, `owner: ${target} -> ${next}`).toBe(true);
      }
    }
  });

  it("lets an admin make a member a designer, or a designer a member, and nothing more", () => {
    expect(change({ actorRole: "admin", targetRole: "member", newRole: "designer" }).allowed).toBe(true);
    expect(change({ actorRole: "admin", targetRole: "designer", newRole: "member" }).allowed).toBe(true);
  });

  it("does not let an admin make anyone an admin or an owner", () => {
    for (const next of ["admin", "owner"] as const) {
      const result = change({ actorRole: "admin", targetRole: "member", newRole: next });
      expect(result).toMatchObject({ allowed: false, code: "forbidden" });
    }
  });

  it("does not let an admin change an admin or an owner, including themselves", () => {
    for (const target of ["admin", "owner"] as const) {
      expect(change({ actorRole: "admin", targetRole: target, newRole: "member" })).toMatchObject({ allowed: false, code: "forbidden" });
    }
    expect(change({ actorRole: "admin", actorIsTarget: true, targetRole: "admin", newRole: "owner" })).toMatchObject({ allowed: false, code: "forbidden" });
  });

  it("does not let a designer or a member give any role, including to themselves", () => {
    for (const actor of ["designer", "member"] as const) {
      expect(change({ actorRole: actor, targetRole: "member", newRole: "designer" })).toMatchObject({ allowed: false, code: "forbidden" });
      expect(change({ actorRole: actor, actorIsTarget: true, targetRole: actor, newRole: "owner" })).toMatchObject({ allowed: false, code: "forbidden" });
    }
  });

  it("refuses someone who is not in the workspace, a target who is not, and a role that does not exist", () => {
    expect(change({ actorRole: null })).toMatchObject({ allowed: false, code: "not_a_member" });
    expect(change({ targetRole: null })).toMatchObject({ allowed: false, code: "target_missing" });
    expect(change({ newRole: "superuser" as never })).toMatchObject({ allowed: false, code: "unknown_role" });
  });

  it("never lets the last owner be demoted, even by themselves, but allows it once there is another owner", () => {
    const demote = { actorRole: "owner", actorIsTarget: true, targetRole: "owner", newRole: "admin" } as const;
    expect(change({ ...demote, ownerCount: 1 })).toMatchObject({ allowed: false, code: "last_owner" });
    expect(change({ ...demote, ownerCount: 2 }).allowed).toBe(true);
    // Another owner demoting the only owner is the same rule: there would be none left.
    expect(change({ actorRole: "owner", targetRole: "owner", newRole: "member", ownerCount: 1 })).toMatchObject({ allowed: false, code: "last_owner" });
  });

  it("gives a plain reason with every refusal", () => {
    const refusals = [
      change({ actorRole: "member" }),
      change({ actorRole: "admin", newRole: "owner" }),
      change({ actorRole: "owner", targetRole: "owner", newRole: "admin", ownerCount: 1 }),
      change({ targetRole: null }),
    ];
    for (const r of refusals) {
      expect(r.allowed).toBe(false);
      if (!r.allowed) expect(r.reason.length).toBeGreaterThan(10);
    }
  });
});

const remove = (over: Partial<Parameters<typeof checkRemoveMember>[0]> = {}) =>
  checkRemoveMember({ actorRole: "owner", actorIsTarget: false, targetRole: "member", ownerCount: 1, ...over });

describe("checkRemoveMember: who may remove whom, and leaving", () => {
  it("lets an owner remove anyone except the last owner", () => {
    for (const target of ["admin", "designer", "member"] as const) expect(remove({ targetRole: target }).allowed).toBe(true);
    expect(remove({ targetRole: "owner", ownerCount: 2 }).allowed).toBe(true);
    expect(remove({ targetRole: "owner", ownerCount: 1 })).toMatchObject({ allowed: false, code: "last_owner" });
  });

  it("lets an admin remove a member or a designer, but not an admin or an owner", () => {
    for (const target of ["designer", "member"] as const) expect(remove({ actorRole: "admin", targetRole: target }).allowed).toBe(true);
    for (const target of ["admin", "owner"] as const) expect(remove({ actorRole: "admin", targetRole: target })).toMatchObject({ allowed: false, code: "forbidden" });
  });

  it("does not let a designer or a member remove anyone else", () => {
    for (const actor of ["designer", "member"] as const) expect(remove({ actorRole: actor, targetRole: "member" })).toMatchObject({ allowed: false, code: "forbidden" });
  });

  it("lets anyone leave for themselves, except the last owner", () => {
    for (const role of ["admin", "designer", "member"] as const) {
      expect(remove({ actorRole: role, actorIsTarget: true, targetRole: role }).allowed).toBe(true);
    }
    expect(remove({ actorRole: "owner", actorIsTarget: true, targetRole: "owner", ownerCount: 2 }).allowed).toBe(true);
    expect(remove({ actorRole: "owner", actorIsTarget: true, targetRole: "owner", ownerCount: 1 })).toMatchObject({ allowed: false, code: "last_owner" });
  });

  it("refuses someone outside the workspace and a target who is not in it", () => {
    expect(remove({ actorRole: null })).toMatchObject({ allowed: false, code: "not_a_member" });
    expect(remove({ targetRole: null })).toMatchObject({ allowed: false, code: "target_missing" });
  });
});
