import { describe, it, expect, afterEach } from "vitest";
import { Viewport } from "../Viewport";

// The room re-fits the whole map when the window is resized, but only while the person has not zoomed or moved
// the view themselves: a person who zoomed in on their desk must not be thrown back to the whole map by a resize.
// The Viewport keeps that one fact, "is the view still the fitted one?".

const FLOOR = { width: 2880, height: 1920 };
const WINDOW = { width: 1280, height: 720 };

let viewport: Viewport | null = null;

function make(): Viewport {
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  viewport = new Viewport(canvas, { onClickToWalk: () => {} });
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

  it("stops being fitted when the person drags the map", () => {
    const v = make();
    v.fitToFloor(FLOOR, WINDOW);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })); // space held: the left button pans
    pointer(document.querySelector("canvas")!, "pointerdown", 100, 100);
    pointer(window, "pointermove", 160, 140);
    pointer(window, "pointerup", 160, 140);
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
    expect(v.isFitted()).toBe(false);
  });

  it("stays fitted after a plain click, which only walks and never moves the view", () => {
    const v = make();
    v.fitToFloor(FLOOR, WINDOW);
    pointer(document.querySelector("canvas")!, "pointerdown", 100, 100);
    pointer(window, "pointerup", 100, 100);
    expect(v.isFitted()).toBe(true);
  });
});
