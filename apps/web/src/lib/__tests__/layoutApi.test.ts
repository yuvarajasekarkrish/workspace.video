// @vitest-environment node
import { describe, it, expect } from "vitest";
import { answer } from "../layoutApi";

// The layout routes turn a database refusal into a response. A workspace on the smallest plan that tries to save,
// publish or restore its own map must get a clear 403 with the plain message and a stable reason the screen can
// react to (docs/architecture/company-map-builder.md, D16), not a 500 or an empty error.

describe("answer: turning a refusal into a response", () => {
  it("makes a plan refusal a 403 that carries the plain message and the reason 'plan_required'", async () => {
    const response = answer({ ok: false, reason: "plan_required", message: "Your plan does not include the map builder. Choose a ready-made template instead." });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Your plan does not include the map builder. Choose a ready-made template instead.",
      reason: "plan_required",
    });
  });

  it("keeps the other refusals as they were", () => {
    const status = (reason: "forbidden" | "not_found" | "invalid" | "conflict" | "last_owner") => answer({ ok: false, reason, message: "x" }).status;
    expect([status("forbidden"), status("not_found"), status("invalid"), status("conflict"), status("last_owner")]).toEqual([403, 404, 400, 409, 409]);
  });

  it("passes a success through unchanged", async () => {
    const response = answer({ ok: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
});
