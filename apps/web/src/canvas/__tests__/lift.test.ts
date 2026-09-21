import { describe, it, expect } from "vitest";
import { TILE_PX, type RoomLayout } from "@workspace-video/shared";
import { project } from "../isoMath";
import { HOVER_LIFT, LiftState, liftVector, pickSlab, screenStep, stepLift } from "../lift";
import { planFloor } from "../slabPlan";

// Raising an area under the mouse (elevation only, no colour change). These pin the maths so a raised area rises
// straight up the screen, settles by itself (so the drawing loop can rest and save battery), and does not flicker.

const layout = {
  zones: [
    { id: "a", label: "A", rect: { col: 0, row: 0, cols: 4, rows: 4 } },
    { id: "b", label: "B", rect: { col: 4, row: 0, cols: 4, rows: 4 } },
  ],
  seats: [],
  furniture: [],
} as unknown as RoomLayout;

describe("liftVector", () => {
  it("makes something appear exactly that much higher on the screen, with no sideways move", () => {
    for (const height of [1, 20, 55]) {
      const shown = project(liftVector(height), { x: 0, y: 0 }, 1);
      expect(shown.x).toBeCloseTo(0, 8);
      expect(shown.y).toBeCloseTo(-height, 8);
    }
  });

  it("is a step of nothing for a lift of nothing", () => {
    const step = liftVector(0);
    expect(step.x).toBeCloseTo(0, 10);
    expect(step.y).toBeCloseTo(0, 10);
  });
});

describe("screenStep", () => {
  it("moves a thing the asked distance right and down on the screen", () => {
    const shown = project(screenStep(-6, 6), { x: 0, y: 0 }, 1);
    expect(shown.x).toBeCloseTo(-6, 8);
    expect(shown.y).toBeCloseTo(6, 8);
  });
});

describe("stepLift", () => {
  it("moves toward the target without passing it, and lands exactly on it", () => {
    let value = 0;
    let previous = -1;
    for (let i = 0; i < 200; i++) {
      value = stepLift(value, HOVER_LIFT, 1 / 60);
      expect(value).toBeGreaterThanOrEqual(previous);
      expect(value).toBeLessThanOrEqual(HOVER_LIFT);
      previous = value;
    }
    expect(value).toBe(HOVER_LIFT);
  });

  it("settles in well under a second, at any frame rate", () => {
    for (const fps of [30, 60, 144]) {
      let value = 0;
      let frames = 0;
      while (value !== HOVER_LIFT && frames < 1000) {
        value = stepLift(value, HOVER_LIFT, 1 / fps);
        frames++;
      }
      expect(frames / fps).toBeLessThan(0.6);
    }
  });

  it("does not jump past the target when a frame takes very long", () => {
    expect(stepLift(0, HOVER_LIFT, 5)).toBeLessThanOrEqual(HOVER_LIFT);
  });
});

describe("LiftState: the rest of the drawing loop can stop when nothing is raised", () => {
  it("is not active until an area is hovered, is active while rising, and is not active again once it has come back down", () => {
    const state = new LiftState();
    expect(state.isActive()).toBe(false);

    state.setHovered("a");
    expect(state.isActive()).toBe(true);
    for (let i = 0; i < 120; i++) state.step(1 / 60);
    expect(state.liftOf("a")).toBe(HOVER_LIFT);
    expect(state.isActive()).toBe(true); // still hovered, still raised

    state.setHovered(null);
    for (let i = 0; i < 120; i++) state.step(1 / 60);
    expect(state.liftOf("a")).toBe(0);
    expect(state.isActive()).toBe(false);
  });

  it("lowers the old area while raising the new one when the mouse crosses between two", () => {
    const state = new LiftState();
    state.setHovered("a");
    for (let i = 0; i < 120; i++) state.step(1 / 60);
    state.setHovered("b");
    for (let i = 0; i < 120; i++) state.step(1 / 60);
    expect(state.liftOf("a")).toBe(0);
    expect(state.liftOf("b")).toBe(HOVER_LIFT);
  });

  it("reports which areas moved this frame, and none once everything has settled", () => {
    const state = new LiftState();
    state.setHovered("a");
    expect(state.step(1 / 60)).toEqual(["a"]);
    for (let i = 0; i < 120; i++) state.step(1 / 60);
    expect(state.step(1 / 60)).toEqual([]);
  });
});

describe("pickSlab", () => {
  const plan = planFloor(layout);
  const inA = { x: TILE_PX * 2, y: TILE_PX * 2 };
  const inB = { x: TILE_PX * 6, y: TILE_PX * 2 };

  it("finds the plate under the mouse, or none over empty floor", () => {
    expect(pickSlab(plan, inA, null)).toBe("a");
    expect(pickSlab(plan, inB, null)).toBe("b");
    expect(pickSlab(plan, { x: TILE_PX * 20, y: TILE_PX * 20 }, null)).toBeNull();
  });

  it("keeps a raised area picked while the mouse is still over where it is drawn, even if that is just off its flat footprint", () => {
    // The raised area is drawn shifted by liftVector; a point just past its flat edge, but inside the shifted copy,
    // must still count, or the area would drop and rise again at the edge.
    const step = liftVector(HOVER_LIFT);
    const edgeInside = { x: TILE_PX * 4 + step.x * 0.5, y: TILE_PX * 2 + step.y * 0.5 }; // flat floor says B, drawing says A
    const zoneAtEdge = pickSlab(plan, edgeInside, null);
    const kept = pickSlab(plan, edgeInside, { slabId: "a", lift: HOVER_LIFT });
    expect(kept).toBe("a");
    expect(zoneAtEdge === "a" || zoneAtEdge === "b").toBe(true);
  });

  it("lets go of an area once the mouse is clearly outside it", () => {
    expect(pickSlab(plan, inB, { slabId: "a", lift: HOVER_LIFT })).toBe("b");
  });
});
