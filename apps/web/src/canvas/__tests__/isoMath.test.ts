import { describe, it, expect } from "vitest";
import { isoMatrix, project, unproject, zoomAtCursor, uprightMatrix, fitFloor } from "../isoMath";
import { MIN_ZOOM, MAX_ZOOM } from "../viewportMath";

// The 2.5D view of the room: the flat floor is turned a quarter of the way round (45 degrees) and leaned back (55
// degrees), exactly as on the owner's Gemini map. All clicking, walking, zooming and fitting go through these
// functions, so a click on the tilted picture and a position on the server always agree.

const SQ = Math.SQRT1_2;
const LEAN = Math.cos((55 * Math.PI) / 180);

describe("isoMatrix", () => {
  it("turns the floor 45 degrees and squashes it by cos(55 degrees), scaled by the zoom", () => {
    const m = isoMatrix(1);
    expect(m.a).toBeCloseTo(SQ, 10);
    expect(m.c).toBeCloseTo(SQ, 10);
    expect(m.b).toBeCloseTo(-LEAN * SQ, 10);
    expect(m.d).toBeCloseTo(LEAN * SQ, 10);
    const z = isoMatrix(0.5);
    expect(z.a).toBeCloseTo(SQ / 2, 10);
    expect(z.d).toBeCloseTo((LEAN * SQ) / 2, 10);
  });
});

describe("project: where a floor position appears on the screen", () => {
  const origin = { x: 300, y: 200 };

  it("puts the floor's top-left corner at the position, and the far corner of a square floor to the right of it, level", () => {
    expect(project({ x: 0, y: 0 }, origin, 1)).toEqual(origin);
    const far = project({ x: 100, y: 100 }, origin, 1);
    expect(far.x).toBeCloseTo(origin.x + 2 * SQ * 100, 8);
    expect(far.y).toBeCloseTo(origin.y, 8);
  });

  it("moves right along the floor toward the upper right of the screen, and down the floor toward the lower right", () => {
    const right = project({ x: 100, y: 0 }, origin, 1);
    expect(right.x).toBeGreaterThan(origin.x);
    expect(right.y).toBeLessThan(origin.y);
    const down = project({ x: 0, y: 100 }, origin, 1);
    expect(down.x).toBeGreaterThan(origin.x);
    expect(down.y).toBeGreaterThan(origin.y);
  });
});

describe("unproject: which floor position a click on the screen means", () => {
  it("undoes project exactly, at any zoom and any position of the view", () => {
    const points = [{ x: 0, y: 0 }, { x: 1440, y: 960 }, { x: 2880, y: 1920 }, { x: 37.5, y: 1999.25 }, { x: -50, y: -80 }];
    const views = [{ x: 0, y: 0 }, { x: 640, y: 360 }, { x: -1200, y: 3000 }];
    for (const scale of [0.25, 0.36, 1, 3]) {
      for (const position of views) {
        for (const p of points) {
          const back = unproject(project(p, position, scale), position, scale);
          expect(back.x).toBeCloseTo(p.x, 6);
          expect(back.y).toBeCloseTo(p.y, 6);
        }
      }
    }
  });
});

describe("zoomAtCursor: zooming keeps the spot under the mouse where it is", () => {
  it("leaves the floor position under the cursor under the cursor after the zoom", () => {
    const cursor = { x: 700, y: 420 };
    const position = { x: 200, y: 100 };
    const before = unproject(cursor, position, 0.4);
    for (const factor of [1.1, 1 / 1.1, 2, 0.5]) {
      const next = zoomAtCursor(cursor, position, 0.4, factor);
      const under = project(before, next.position, next.scale);
      expect(under.x).toBeCloseTo(cursor.x, 6);
      expect(under.y).toBeCloseTo(cursor.y, 6);
    }
  });

  it("never zooms past the smallest or largest zoom, and still keeps the spot under the mouse", () => {
    const cursor = { x: 500, y: 300 };
    const position = { x: 0, y: 0 };
    expect(zoomAtCursor(cursor, position, 1, 1000).scale).toBe(MAX_ZOOM);
    expect(zoomAtCursor(cursor, position, 1, 0.0001).scale).toBe(MIN_ZOOM);
    const before = unproject(cursor, position, 1);
    const next = zoomAtCursor(cursor, position, 1, 1000);
    const under = project(before, next.position, next.scale);
    expect(under.x).toBeCloseTo(cursor.x, 6);
    expect(under.y).toBeCloseTo(cursor.y, 6);
  });
});

describe("uprightMatrix: keeps a person standing straight on the tilted floor", () => {
  const multiply = (p: { a: number; b: number; c: number; d: number }, q: { a: number; b: number; c: number; d: number }) => ({
    a: p.a * q.a + p.c * q.b,
    b: p.b * q.a + p.d * q.b,
    c: p.a * q.c + p.c * q.d,
    d: p.b * q.c + p.d * q.d,
  });

  it("cancels the tilt exactly, so a dot drawn in it stays round and its name stays level", () => {
    const product = multiply(isoMatrix(1), uprightMatrix());
    expect(product.a).toBeCloseTo(1, 10);
    expect(product.d).toBeCloseTo(1, 10);
    expect(product.b).toBeCloseTo(0, 10);
    expect(product.c).toBeCloseTo(0, 10);
  });

  it("still lets the zoom scale it, so people grow and shrink with the map", () => {
    const product = multiply(isoMatrix(0.4), uprightMatrix());
    expect(product.a).toBeCloseTo(0.4, 10);
    expect(product.d).toBeCloseTo(0.4, 10);
    expect(product.b).toBeCloseTo(0, 10);
    expect(product.c).toBeCloseTo(0, 10);
  });
});

describe("fitFloor: the whole floor on the screen, centred", () => {
  const corners = (floor: { width: number; height: number }) => [
    { x: 0, y: 0 },
    { x: floor.width, y: 0 },
    { x: 0, y: floor.height },
    { x: floor.width, y: floor.height },
  ];

  it("puts all four corners of the tilted floor inside the window and centres it, for a laptop, a monitor and a phone", () => {
    const floor = { width: 2880, height: 1920 };
    for (const view of [{ width: 1440, height: 900 }, { width: 1920, height: 1080 }, { width: 390, height: 700 }]) {
      const fit = fitFloor(floor, view);
      const screen = corners(floor).map((c) => project(c, fit.position, fit.scale));
      const xs = screen.map((p) => p.x);
      const ys = screen.map((p) => p.y);
      expect(Math.min(...xs)).toBeGreaterThanOrEqual(-0.001);
      expect(Math.max(...xs)).toBeLessThanOrEqual(view.width + 0.001);
      expect(Math.min(...ys)).toBeGreaterThanOrEqual(-0.001);
      expect(Math.max(...ys)).toBeLessThanOrEqual(view.height + 0.001);
      expect((Math.min(...xs) + Math.max(...xs)) / 2).toBeCloseTo(view.width / 2, 3);
      expect((Math.min(...ys) + Math.max(...ys)) / 2).toBeCloseTo(view.height / 2, 3);
    }
  });

  it("leaves a margin around the floor, so it does not touch the edges", () => {
    const floor = { width: 2880, height: 1920 };
    const view = { width: 1440, height: 900 };
    const fit = fitFloor(floor, view, 0.9);
    const screen = corners(floor).map((c) => project(c, fit.position, fit.scale));
    const width = Math.max(...screen.map((p) => p.x)) - Math.min(...screen.map((p) => p.x));
    const height = Math.max(...screen.map((p) => p.y)) - Math.min(...screen.map((p) => p.y));
    expect(Math.max(width / view.width, height / view.height)).toBeCloseTo(0.9, 3);
  });

  it("stays inside the allowed zoom range, and copes with an empty window or floor", () => {
    expect(fitFloor({ width: 50000, height: 50000 }, { width: 300, height: 200 }).scale).toBe(MIN_ZOOM);
    expect(fitFloor({ width: 100, height: 100 }, { width: 5000, height: 5000 }).scale).toBe(MAX_ZOOM);
    expect(fitFloor({ width: 0, height: 100 }, { width: 800, height: 600 })).toEqual({ scale: 1, position: { x: 0, y: 0 } });
    expect(fitFloor({ width: 100, height: 100 }, { width: 0, height: 600 })).toEqual({ scale: 1, position: { x: 0, y: 0 } });
  });
});
