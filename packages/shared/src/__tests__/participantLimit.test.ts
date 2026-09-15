import { describe, it, expect } from "vitest";
import { admitParticipant } from "../participantLimit";

describe("admitParticipant", () => {
  it("admits a new user below the limit", () => {
    const active = new Set(["a", "b"]);
    expect(admitParticipant(active, "c", 10)).toEqual({ admitted: true });
  });

  it("rejects a new user at the limit, reporting workspace_full with limit and active", () => {
    const active = new Set(["a", "b", "c"]);
    expect(admitParticipant(active, "d", 3)).toEqual({
      admitted: false,
      reason: "workspace_full",
      limit: 3,
      active: 3,
    });
  });

  it("always readmits an already-active user, even exactly at capacity", () => {
    const active = new Set(["a", "b", "c"]);
    expect(admitParticipant(active, "a", 3)).toEqual({ admitted: true });
  });

  it("counts distinct user ids, not connections", () => {
    // Same userId "a" appearing once in the active set represents however
    // many sockets/tabs that user has open — admission must not multiply.
    const active = new Set(["a"]);
    expect(admitParticipant(active, "a", 1).admitted).toBe(true);
    expect(admitParticipant(active, "b", 1).admitted).toBe(false);
  });

  it("fails closed on a non-positive limit", () => {
    const active = new Set<string>();
    expect(admitParticipant(active, "a", 0)).toEqual({
      admitted: false,
      reason: "workspace_full",
      limit: 0,
      active: 0,
    });
    expect(admitParticipant(active, "a", -5).admitted).toBe(false);
  });

  it("fails closed on a non-integer limit", () => {
    const active = new Set<string>();
    expect(admitParticipant(active, "a", 3.5).admitted).toBe(false);
    expect(admitParticipant(active, "a", NaN).admitted).toBe(false);
  });

  it("admits at limit 1 with zero active, then rejects the next distinct user", () => {
    const active = new Set<string>();
    expect(admitParticipant(active, "a", 1)).toEqual({ admitted: true });
    active.add("a");
    expect(admitParticipant(active, "b", 1)).toEqual({
      admitted: false,
      reason: "workspace_full",
      limit: 1,
      active: 1,
    });
  });
});
