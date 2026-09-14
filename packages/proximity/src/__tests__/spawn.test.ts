import { describe, it, expect } from "vitest";
import { spawnPositionForUser } from "../spawn.js";

describe("spawnPositionForUser", () => {
  const base = { x: 100, y: 100 };

  it("is deterministic for the same user id", () => {
    const a = spawnPositionForUser("user-1", base);
    const b = spawnPositionForUser("user-1", base);
    expect(a).toEqual(b);
  });

  it("gives distinct users distinct positions", () => {
    const a = spawnPositionForUser("user-1", base);
    const b = spawnPositionForUser("user-2", base);
    expect(a).not.toEqual(b);
  });

  it("keeps the offset within the given ring radius of the base", () => {
    const p = spawnPositionForUser("user-1", base, 60);
    const dist = Math.hypot(p.x - base.x, p.y - base.y);
    expect(dist).toBeLessThanOrEqual(60 + 1e-9);
  });

  it("clamps into bounds when the base point sits near an edge", () => {
    const nearEdge = { x: 10, y: 10 };
    const bounds = { clientThrottleMs: 50, maxSpeedPxPerSec: 2000, roomWidthPx: 8000, roomHeightPx: 8000 };
    const p = spawnPositionForUser("user-1", nearEdge, 60, bounds);
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.y).toBeGreaterThanOrEqual(0);
    expect(p.x).toBeLessThanOrEqual(bounds.roomWidthPx);
    expect(p.y).toBeLessThanOrEqual(bounds.roomHeightPx);
  });

  it("spreads many distinct user ids across multiple ring positions (not all identical)", () => {
    const positions = Array.from({ length: 20 }, (_, i) => spawnPositionForUser(`user-${i}`, base));
    const distinct = new Set(positions.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`));
    expect(distinct.size).toBeGreaterThan(1);
  });
});
