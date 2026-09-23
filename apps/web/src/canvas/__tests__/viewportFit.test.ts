import { describe, it, expect, afterEach } from "vitest";
import { Viewport } from "../Viewport";
import { fitInsets, FLOOR_MARGIN, MAX_ZOOM_OVER_FIT } from "../viewportMath";

// The room re-fits the whole map when the window is resized, but only while the person has not zoomed or moved
// the view themselves: a person who zoomed in on their desk must not be thrown back to the whole map by a resize.
// The Viewport keeps that one fact, "is the view still the fitted one?".

const FLOOR = { width: 2880, height: 1920 };
const WINDOW = { width: 1280, height: 720 };

let viewport: Viewport | null = null;

function make(tilted = true): Viewport {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  viewport = new Viewport(canvas, { onClickToWalk: () => {} }, tilted);
  return viewport;
}

function pointer(canvasOrWindow: EventTarget, type: string, x: number, y: number): void {
  const event = Object.assign(new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }), { pointerId: 1 });
  canvasOrWindow.dispatchEvent(event);
}

afterEach(() => {
  viewport?.dispose();
  viewport = null;
  document.body.innerHTML = "";
});

describe("Viewport.isFitted", () => {
  it("is not fitted until the map has been fitted once", () => {
    expect(make().isFitted()).toBe(false);
  });

  it("is fitted right after fitting the whole map", () => {
    const v = make();
    v.fitToFloor(FLOOR, WINDOW);
    expect(v.isFitted()).toBe(true);
  });

  it("stops being fitted when the person zooms (wheel or the zoom buttons), and is fitted again after the fit button", () => {
    const v = make();
    v.fitToFloor(FLOOR, WINDOW);
    v.zoomAt({ x: 640, y: 360 }, 1.25);
    expect(v.isFitted()).toBe(false);
    v.fitToFloor(FLOOR, WINDOW);
    expect(v.isFitted()).toBe(true);
  });

  it("stays fixed when the person drags: the map never pans (the owner's call, 2026-09-23)", () => {
    const v = make();
    v.fitToFloor(FLOOR, WINDOW);
    const before = v.worldToScreen({ x: 0, y: 0 });
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" }));
    pointer(document.querySelector("canvas")!, "pointerdown", 100, 100);
    pointer(window, "pointermove", 160, 140);
    pointer(window, "pointerup", 160, 140);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    expect(v.isFitted()).toBe(true);
    expect(v.worldToScreen({ x: 0, y: 0 })).toEqual(before);
  });

  it("keeps the fitted floor clear of the top pills, side panels and bottom dock", () => {
    const v = make();
    v.fitToFloor(FLOOR, WINDOW);
    const m = FLOOR_MARGIN;
    const corners = [v.worldToScreen({ x: -m, y: -m }), v.worldToScreen({ x: FLOOR.width + m, y: -m }), v.worldToScreen({ x: -m, y: FLOOR.height + m }), v.worldToScreen({ x: FLOOR.width + m, y: FLOOR.height + m })];
    const inset = fitInsets(WINDOW);
    for (const c of corners) {
      expect(c.x).toBeGreaterThanOrEqual(inset.left - 0.5);
      expect(c.x).toBeLessThanOrEqual(WINDOW.width - inset.right + 0.5);
      expect(c.y).toBeGreaterThanOrEqual(inset.top - 0.5);
      expect(c.y).toBeLessThanOrEqual(WINDOW.height - inset.bottom + 0.5);
    }
  });

  it("fits a small office (about 10 people) into the same clear space as a big one, centred (flat view)", () => {
    const v = make(false);
    const small = { width: 3 * 160, height: 2 * 160 };
    v.fitToFloor(small, WINDOW);
    // the drawn floor: the layout plus the margin FloorView draws around it
    const tl = v.worldToScreen({ x: -FLOOR_MARGIN, y: -FLOOR_MARGIN }), br = v.worldToScreen({ x: small.width + FLOOR_MARGIN, y: small.height + FLOOR_MARGIN });
    const inset = fitInsets(WINDOW);
    expect(tl.x).toBeGreaterThanOrEqual(inset.left - 0.5);
    expect(br.x).toBeLessThanOrEqual(WINDOW.width - inset.right + 0.5);
    expect(tl.y).toBeGreaterThanOrEqual(inset.top - 0.5);
    expect(br.y).toBeLessThanOrEqual(WINDOW.height - inset.bottom + 0.5);
    // it fills the space in at least one direction, not a tiny map in the middle
    const usedW = (br.x - tl.x) / (WINDOW.width - inset.left - inset.right);
    const usedH = (br.y - tl.y) / (WINDOW.height - inset.top - inset.bottom);
    expect(Math.max(usedW, usedH)).toBeGreaterThan(0.95);
  });

  it("zooms only between the fitted view and MAX_ZOOM_OVER_FIT times it", () => {
    const v = make();
    v.fitToFloor(FLOOR, WINDOW);
    const fit = v.getScale();
    for (let i = 0; i < 10; i++) v.zoomAt({ x: 400, y: 300 }, 1 / 1.2);
    expect(v.getScale()).toBeCloseTo(fit);
    expect(v.isFitted()).toBe(true);
    for (let i = 0; i < 40; i++) v.zoomAt({ x: 400, y: 300 }, 1.2);
    expect(v.getScale()).toBeCloseTo(fit * MAX_ZOOM_OVER_FIT);
  });

  it("stays fitted after a plain click, which only walks and never moves the view", () => {
    const v = make();
    v.fitToFloor(FLOOR, WINDOW);
    pointer(document.querySelector("canvas")!, "pointerdown", 100, 100);
    pointer(window, "pointerup", 100, 100);
    expect(v.isFitted()).toBe(true);
  });
});

// D20: a workspace's flat/tilted choice is fixed for the Viewport's whole life. This proves the
// third constructor argument actually reaches every isoMath call the Viewport makes, not just
// applyTransform — worldToScreen/screenToWorld must round-trip correctly in flat mode too, which a
// stray tilted=true left somewhere inside Viewport.ts would break.
describe("Viewport in flat mode (tilted = false)", () => {
  it("still fits the whole floor and stays fitted the same way as tilted mode", () => {
    const v = make(false);
    v.fitToFloor(FLOOR, WINDOW);
    expect(v.isFitted()).toBe(true);
    v.zoomAt({ x: 640, y: 360 }, 1.25);
    expect(v.isFitted()).toBe(false);
  });

  it("worldToScreen and screenToWorld round-trip exactly in flat mode", () => {
    const v = make(false);
    v.fitToFloor(FLOOR, WINDOW);
    const world = { x: 1200, y: 800 };
    const screen = v.worldToScreen(world);
    const back = v.screenToWorld(screen);
    expect(back.x).toBeCloseTo(world.x, 6);
    expect(back.y).toBeCloseTo(world.y, 6);
  });

  it("draws the floor with no rotation: moving right on the floor moves straight right on screen, not diagonally", () => {
    const v = make(false);
    v.fitToFloor(FLOOR, WINDOW);
    const a = v.worldToScreen({ x: 0, y: 0 });
    const b = v.worldToScreen({ x: 200, y: 0 });
    expect(b.y).toBeCloseTo(a.y, 6); // tilted mode would move up-right, not straight right
    expect(b.x).toBeGreaterThan(a.x);
  });
});
