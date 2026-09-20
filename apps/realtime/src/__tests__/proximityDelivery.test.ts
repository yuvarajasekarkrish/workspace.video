import { describe, it, expect } from "vitest";
import { checkProximityDelivery } from "../proximityDelivery.js";

describe("checkProximityDelivery", () => {
  it("passes when clients received the updates the server queued", () => {
    const r = checkProximityDelivery({ serverUpdates: 100_000, clientUpdates: 100_000 });
    expect(r.ok).toBe(true);
    expect(r.ratio).toBe(1);
  });

  it("tolerates a small in-flight difference at the window edges, in either direction", () => {
    expect(checkProximityDelivery({ serverUpdates: 100_000, clientUpdates: 99_000 }).ok).toBe(true);
    expect(checkProximityDelivery({ serverUpdates: 100_000, clientUpdates: 101_000 }).ok).toBe(true);
  });

  it("fails when clients received clearly fewer or clearly more than was queued", () => {
    expect(checkProximityDelivery({ serverUpdates: 100_000, clientUpdates: 90_000 }).ok).toBe(false);
    expect(checkProximityDelivery({ serverUpdates: 100_000, clientUpdates: 110_000 }).ok).toBe(false);
  });

  it("uses an absolute floor so a tiny run is not judged on a percentage of almost nothing", () => {
    expect(checkProximityDelivery({ serverUpdates: 10, clientUpdates: 14 }).ok).toBe(true);
    expect(checkProximityDelivery({ serverUpdates: 10, clientUpdates: 200 }).ok).toBe(false);
  });

  it("reports n/a instead of dividing by zero when the server queued nothing", () => {
    const r = checkProximityDelivery({ serverUpdates: 0, clientUpdates: 0 });
    expect(r.ratio).toBeNull();
    expect(r.ok).toBe(true);
    expect(checkProximityDelivery({ serverUpdates: 0, clientUpdates: 500 }).ok).toBe(false);
  });
});
