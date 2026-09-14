import { describe, it, expect } from "vitest";
import type { ObjectState } from "@cosmos/shared";
import { resolveObjectWrite, resolveObjectDelete, type ProposedObjectWrite } from "../objectLww";

function makeProposal(overrides: Partial<ProposedObjectWrite> = {}): ProposedObjectWrite {
  return {
    objectId: "obj1",
    roomId: "room1",
    type: "note",
    x: 10,
    y: 20,
    width: 100,
    height: 80,
    rotation: 0,
    z: 0,
    data: { text: "hi" },
    baseVersion: 0,
    ...overrides,
  };
}

function makeExisting(overrides: Partial<ObjectState> = {}): ObjectState {
  return {
    objectId: "obj1",
    roomId: "room1",
    type: "note",
    x: 0,
    y: 0,
    width: 100,
    height: 80,
    rotation: 0,
    z: 0,
    data: { text: "original" },
    version: 3,
    createdById: "creator1",
    ...overrides,
  };
}

describe("resolveObjectWrite", () => {
  it("accepts a create (baseVersion 0) when no object exists yet", () => {
    const result = resolveObjectWrite(makeProposal({ baseVersion: 0 }), undefined, "u1");
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.next.version).toBe(1);
      expect(result.next.createdById).toBe("u1");
      expect(result.next.objectId).toBe("obj1");
    }
  });

  it("rejects a create when the id already exists (collision), returning authoritative state", () => {
    const existing = makeExisting();
    const result = resolveObjectWrite(makeProposal({ baseVersion: 0 }), existing, "u2");
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("id_collision");
      expect(result.authoritative).toEqual(existing);
    }
  });

  it("accepts an edit whose baseVersion matches the current version", () => {
    const existing = makeExisting({ version: 3 });
    const result = resolveObjectWrite(makeProposal({ baseVersion: 3, x: 50 }), existing, "u2");
    expect(result.accepted).toBe(true);
    if (result.accepted) {
      expect(result.next.version).toBe(4);
      expect(result.next.x).toBe(50);
      // createdById is fixed at creation and never changes on edit, even
      // when a different user (u2) performs the edit.
      expect(result.next.createdById).toBe("creator1");
    }
  });

  it("rejects an edit with a stale baseVersion and returns the authoritative state", () => {
    const existing = makeExisting({ version: 5 });
    const result = resolveObjectWrite(makeProposal({ baseVersion: 3 }), existing, "u2");
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("stale_version");
      expect(result.authoritative).toEqual(existing);
    }
  });

  it("rejects an edit against an object that no longer exists, with no authoritative state", () => {
    const result = resolveObjectWrite(makeProposal({ baseVersion: 2 }), undefined, "u2");
    expect(result.accepted).toBe(false);
    if (!result.accepted) {
      expect(result.reason).toBe("not_found");
      expect(result.authoritative).toBeNull();
    }
  });
});

describe("resolveObjectDelete", () => {
  it("accepts a delete from the creator with a matching version", () => {
    const existing = makeExisting({ createdById: "creator1", version: 3 });
    const result = resolveObjectDelete("obj1", 3, existing, "creator1");
    expect(result.outcome).toBe("deleted");
  });

  it("rejects a delete from a non-creator", () => {
    const existing = makeExisting({ createdById: "creator1", version: 3 });
    const result = resolveObjectDelete("obj1", 3, existing, "someone-else");
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("not_creator");
      expect(result.authoritative).toEqual(existing);
    }
  });

  it("rejects a delete with a stale baseVersion even from the creator", () => {
    const existing = makeExisting({ createdById: "creator1", version: 5 });
    const result = resolveObjectDelete("obj1", 3, existing, "creator1");
    expect(result.outcome).toBe("rejected");
    if (result.outcome === "rejected") {
      expect(result.reason).toBe("stale_version");
    }
  });

  it("treats deleting an already-gone object as a successful no-op", () => {
    const result = resolveObjectDelete("obj1", 3, undefined, "creator1");
    expect(result.outcome).toBe("already_gone");
  });
});
