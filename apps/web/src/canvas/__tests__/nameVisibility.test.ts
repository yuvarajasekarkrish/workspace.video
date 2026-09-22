import { describe, it, expect } from "vitest";
import { computeNameVisibility } from "../nameVisibility";

const RADIUS = 200;

describe("computeNameVisibility (D17, decision 5B)", () => {
  it("always shows the local person's own name", () => {
    const visible = computeNameVisibility({
      positions: new Map([["me", { x: 0, y: 0 }]]),
      localUserId: "me",
      nearbyRadiusPx: RADIUS,
      hoveredUserId: null,
      highlightedUserId: null,
    });
    expect(visible.has("me")).toBe(true);
  });

  it("shows someone within the nearby radius, and hides someone just outside it", () => {
    const visible = computeNameVisibility({
      positions: new Map([
        ["me", { x: 0, y: 0 }],
        ["close", { x: RADIUS - 1, y: 0 }],
        ["far", { x: RADIUS + 1, y: 0 }],
      ]),
      localUserId: "me",
      nearbyRadiusPx: RADIUS,
      hoveredUserId: null,
      highlightedUserId: null,
    });
    expect(visible.has("close")).toBe(true);
    expect(visible.has("far")).toBe(false);
  });

  it("treats exactly the radius as nearby (inclusive boundary)", () => {
    const visible = computeNameVisibility({
      positions: new Map([
        ["me", { x: 0, y: 0 }],
        ["edge", { x: RADIUS, y: 0 }],
      ]),
      localUserId: "me",
      nearbyRadiusPx: RADIUS,
      hoveredUserId: null,
      highlightedUserId: null,
    });
    expect(visible.has("edge")).toBe(true);
  });

  it("shows whoever is hovered, however far away", () => {
    const visible = computeNameVisibility({
      positions: new Map([
        ["me", { x: 0, y: 0 }],
        ["far", { x: 5000, y: 5000 }],
      ]),
      localUserId: "me",
      nearbyRadiusPx: RADIUS,
      hoveredUserId: "far",
      highlightedUserId: null,
    });
    expect(visible.has("far")).toBe(true);
  });

  it("shows whoever was found through search, however far away", () => {
    const visible = computeNameVisibility({
      positions: new Map([
        ["me", { x: 0, y: 0 }],
        ["found", { x: 5000, y: 5000 }],
      ]),
      localUserId: "me",
      nearbyRadiusPx: RADIUS,
      hoveredUserId: null,
      highlightedUserId: "found",
    });
    expect(visible.has("found")).toBe(true);
  });

  it("hides someone who is far, not hovered, and not the search result", () => {
    const visible = computeNameVisibility({
      positions: new Map([
        ["me", { x: 0, y: 0 }],
        ["stranger", { x: 5000, y: 5000 }],
      ]),
      localUserId: "me",
      nearbyRadiusPx: RADIUS,
      hoveredUserId: null,
      highlightedUserId: null,
    });
    expect(visible.has("stranger")).toBe(false);
  });

  it("never shows the local person's own userId as a match for hovered/highlighted (it's already shown, but this checks no double-count bug)", () => {
    const visible = computeNameVisibility({
      positions: new Map([["me", { x: 0, y: 0 }]]),
      localUserId: "me",
      nearbyRadiusPx: RADIUS,
      hoveredUserId: "me",
      highlightedUserId: "me",
    });
    expect(visible.size).toBe(1);
    expect(visible.has("me")).toBe(true);
  });

  it("copes with the local person missing from positions (a stale computed before their own join)", () => {
    const visible = computeNameVisibility({
      positions: new Map([["someone-else", { x: 0, y: 0 }]]),
      localUserId: "me",
      nearbyRadiusPx: RADIUS,
      hoveredUserId: null,
      highlightedUserId: null,
    });
    expect(visible.has("me")).toBe(false);
    expect(visible.has("someone-else")).toBe(false); // far away by default (no local position to compare)
  });

  it("copes with an empty roster", () => {
    expect(computeNameVisibility({ positions: new Map(), localUserId: "me", nearbyRadiusPx: RADIUS, hoveredUserId: null, highlightedUserId: null }).size).toBe(0);
  });
});
