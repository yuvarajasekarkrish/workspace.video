import { describe, it, expect } from "vitest";
import { PLAN_IDS, PLAN_PARTICIPANT_LIMITS, PLAN_LABELS, PlanIdSchema } from "../plans";

describe("plans", () => {
  it("every PlanId has a positive participant limit", () => {
    for (const id of PLAN_IDS) {
      expect(PLAN_PARTICIPANT_LIMITS[id]).toBeGreaterThan(0);
      expect(Number.isInteger(PLAN_PARTICIPANT_LIMITS[id])).toBe(true);
    }
  });

  it("every PlanId has a label", () => {
    for (const id of PLAN_IDS) {
      expect(PLAN_LABELS[id]).toBeTruthy();
    }
  });

  it("limits strictly increase from startup to enterprise", () => {
    const limits = PLAN_IDS.map((id) => PLAN_PARTICIPANT_LIMITS[id]);
    for (let i = 1; i < limits.length; i++) {
      expect(limits[i]).toBeGreaterThan(limits[i - 1]!);
    }
  });

  it("enterprise is capped at 200 concurrent (no 500-tier this phase)", () => {
    expect(PLAN_PARTICIPANT_LIMITS.enterprise).toBe(200);
    expect(Math.max(...PLAN_IDS.map((id) => PLAN_PARTICIPANT_LIMITS[id]))).toBe(200);
  });

  it("rejects an unknown plan id", () => {
    expect(PlanIdSchema.safeParse("campus").success).toBe(false);
  });
});
