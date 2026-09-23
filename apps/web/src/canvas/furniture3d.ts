import { Graphics } from "pixi.js";
import type { FurniturePiece, LayoutZone, Point } from "@workspace-video/shared";
import { liftVector } from "./lift";
import {
  BLACK,
  CHAIR_BACK,
  CHAIR_SEAT,
  FOLIAGE,
  FRUIT_GREEN,
  FRUIT_RED,
  FRUIT_YELLOW,
  FURNITURE_DARK,
  FURNITURE_LIGHT,
  FURNITURE_MID,
  GLASS,
  MONITOR,
  PARTITION,
  SCREEN_GLOW,
  TABLE_TOP,
  WHITEBOARD,
  WOOD,
} from "./palette";

/**
 * Furniture drawn with height, like the owner's rendered-office reference. Drawing only: every piece keeps the
 * exact position and size the layout gives it, so seats, sitting distance, movement and zones are untouched. A chair
 * is drawn where the layout's chair is, which is where its seat anchor is.
 *
 * On the tilted floor a box's visible sides are the one facing +y (lower right on the screen) and the one facing -x
 * (lower left); height is the flat-floor step that looks straight up on the screen (liftVector), so everything
 * here is plain polygons on the floor plane and stays correct under zoom and pan.
 */

/** In the flat view one pixel of height moves this far up the screen. */
const FLAT_HEIGHT = 0.55;
const SIDE_LEFT = 0.78; // the -x face
const SIDE_RIGHT = 0.56; // the +y face

function shade(color: number, k: number): number {
  const f = (c: number) => Math.max(0, Math.min(255, Math.round(c * k)));
  return (f(color >> 16) << 16) | (f((color >> 8) & 255) << 8) | f(color & 255);
}

interface Box {
  x: number;
  y: number;
  w: number;
  d: number;
}

export class Painter {
  private readonly up: Point;

  /** Height is the flat-floor step that looks straight up on the screen. Looking straight down (the flat view) it is
   *  a shorter step up the screen, so things still show their front faces, like the reference render. */
  constructor(
    readonly g: Graphics,
    tilted: boolean,
  ) {
    this.up = tilted ? liftVector(1) : { x: 0, y: -FLAT_HEIGHT };
  }

  private at(x: number, y: number, z: number): [number, number] {
    return [x + this.up.x * z, y + this.up.y * z];
  }

  /** A box standing on the floor from height z0 to z1 (screen pixels before zoom). */
  box(b: Box, z0: number, z1: number, color: number, alpha = 1): void {
    const { x, y, w, d } = b;
    const P = (px: number, py: number, pz: number) => this.at(px, py, pz);
    const quad = (pts: [number, number][], c: number) => {
      this.g.poly(pts.flat()).fill({ color: c, alpha });
    };
    if (z1 > z0) {
      quad([P(x, y, z0), P(x, y + d, z0), P(x, y + d, z1), P(x, y, z1)], shade(color, SIDE_LEFT));
      quad([P(x, y + d, z0), P(x + w, y + d, z0), P(x + w, y + d, z1), P(x, y + d, z1)], shade(color, SIDE_RIGHT));
    }
    quad([P(x, y, z1), P(x + w, y, z1), P(x + w, y + d, z1), P(x, y + d, z1)], color);
  }

  /** A round-cornered slab (table tops, cushions): a darker copy below, the top above. */
  puck(b: Box, z0: number, z1: number, radius: number, color: number): void {
    const [bx, by] = this.at(b.x, b.y, z0);
    this.g.roundRect(bx, by, b.w, b.d, radius).fill(shade(color, SIDE_RIGHT));
    const steps = Math.max(1, Math.ceil((z1 - z0) / 2));
    for (let i = 1; i <= steps; i++) {
      const [sx, sy] = this.at(b.x, b.y, z0 + ((z1 - z0) * i) / steps);
      this.g.roundRect(sx, sy, b.w, b.d, radius).fill(i === steps ? color : shade(color, SIDE_LEFT));
    }
  }

  line(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, width: number, color: number): void {
    const [ax, ay] = this.at(x0, y0, z0), [bx, by] = this.at(x1, y1, z1);
    this.g.moveTo(ax, ay).lineTo(bx, by).stroke({ width, color, cap: "round" });
  }

  disc(cx: number, cy: number, z: number, r: number, color: number, alpha = 1): void {
    const [x, y] = this.at(cx, cy, z);
    this.g.circle(x, y, r).fill({ color, alpha });
  }

  shadow(b: Box, grow: number, alpha: number): void {
    this.g.roundRect(b.x - grow, b.y - grow, b.w + grow * 2, b.d + grow * 2, grow + 4).fill({ color: BLACK, alpha });
  }
}

/**
 * Which area each piece stands in (piece id -> zone id, or null on the open floor). Set once per floor by
 * setZonesOf before drawing, so a chair only ever turns toward a desk, table or stage in its own area: a chair at the
 * edge of the auditorium faces the stage, never the collaboration table just across the line.
 */
let zoneOfPiece: (piece: FurniturePiece) => string | null = () => null;
export function setZonesOf(lookup: (piece: FurniturePiece) => string | null): void {
  zoneOfPiece = lookup;
}
const sameArea = (a: FurniturePiece, b: FurniturePiece) => zoneOfPiece(a) === zoneOfPiece(b);

/** The nearest point of `t` to (cx, cy), as a step from (cx, cy), and how far it is. */
function towards(cx: number, cy: number, t: FurniturePiece): { v: Point; dist: number } {
  const nx = Math.max(t.x, Math.min(cx, t.x + t.width));
  const ny = Math.max(t.y, Math.min(cy, t.y + t.height));
  return { v: { x: nx - cx, y: ny - cy }, dist: Math.hypot(nx - cx, ny - cy) };
}

function snap(v: Point): Point {
  return Math.abs(v.x) > Math.abs(v.y) ? { x: Math.sign(v.x), y: 0 } : { x: 0, y: Math.sign(v.y) || 1 };
}

/**
 * Which way a chair faces, so every seated person looks at what they are there for: the desk or table they sit at;
 * failing that, the stage or screen they are listening to (the auditorium); failing that, the other people in their
 * group. Drawing only: the seat itself does not move.
 */
export function facingOf(chair: FurniturePiece, all: FurniturePiece[]): Point {
  // The layout formula (chair() in modules.ts) stores the exact direction every chair faces in `rotation`: use it.
  if (Number.isFinite(chair.rotation)) return snap({ x: Math.cos(chair.rotation), y: Math.sin(chair.rotation) });
  const cx = chair.x + chair.width / 2;
  const cy = chair.y + chair.height / 2;
  let best: { v: Point; dist: number } | null = null;
  for (const t of all) {
    if (t.kind !== "desk" && t.kind !== "table" && t.kind !== "counter") continue;
    if (!sameArea(chair, t)) continue;
    const hit = towards(cx, cy, t);
    if (hit.dist < 90 && (!best || hit.dist < best.dist)) best = hit;
  }
  if (best) return snap(best.v);
  for (const t of all) {
    if (t.kind !== "stage" && t.kind !== "screen" && t.kind !== "whiteboard") continue;
    const hit = towards(cx, cy, t);
    if (hit.dist < 900 && (!best || hit.dist < best.dist)) best = hit;
  }
  if (best) return snap(best.v);
  // No table and nothing to watch: turn toward the middle of the nearby chairs (people talking to each other).
  let sx = 0, sy = 0, n = 0;
  for (const o of all) {
    if (o === chair || o.kind !== "chair" || !sameArea(chair, o)) continue;
    const dx = o.x + o.width / 2 - cx, dy = o.y + o.height / 2 - cy;
    if (Math.hypot(dx, dy) < 160) { sx += dx; sy += dy; n++; }
  }
  return n ? snap({ x: sx, y: sy }) : { x: 0, y: 1 };
}

/** A small stable number from an id, so the same desk always gets the same mug or plant. */
function pick(id: string, n: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h % n;
}

/** An office chair: five-star base on castors, gas lift, cushioned seat, armrests and a curved back, facing `face`. */
function drawChair(p: Painter, c: FurniturePiece, face: Point): void {
  const cx = c.x + c.width / 2;
  const cy = c.y + c.height / 2;
  const s = Math.min(c.width, c.height) * 0.92;
  p.shadow({ x: cx - s / 2, y: cy - s / 2, w: s, d: s }, 2, 0.25);
  // five-star base
  for (let i = 0; i < 5; i++) {
    const a = (i / 5) * Math.PI * 2 + 0.3;
    const ex = cx + Math.cos(a) * s * 0.46, ey = cy + Math.sin(a) * s * 0.46;
    p.line(cx, cy, 2, ex, ey, 2, 2, FURNITURE_DARK);
    p.disc(ex, ey, 1, 1.6, MONITOR);
  }
  p.box({ x: cx - 1.5, y: cy - 1.5, w: 3, d: 3 }, 2, 12, FURNITURE_DARK);
  const seat = { x: cx - s / 2, y: cy - s / 2, w: s, d: s };
  const t = s * 0.2;
  const back: Box =
    face.x > 0 ? { x: seat.x - 1, y: seat.y + 1, w: t, d: s - 2 }
    : face.x < 0 ? { x: seat.x + s - t + 1, y: seat.y + 1, w: t, d: s - 2 }
    : face.y > 0 ? { x: seat.x + 1, y: seat.y - 1, w: s - 2, d: t }
    : { x: seat.x + 1, y: seat.y + s - t + 1, w: s - 2, d: t };
  // armrests run along the two sides that are neither front nor back
  const arm = 2.5;
  const arms: Box[] = face.x !== 0
    ? [{ x: seat.x + 3, y: seat.y, w: s - 6, d: arm }, { x: seat.x + 3, y: seat.y + s - arm, w: s - 6, d: arm }]
    : [{ x: seat.x, y: seat.y + 3, w: arm, d: s - 6 }, { x: seat.x + s - arm, y: seat.y + 3, w: arm, d: s - 6 }];
  const backInFront = face.x > 0 || face.y < 0;
  const backColor = CHAIR_BACK;
  if (!backInFront) p.box(back, 14, 34, backColor);
  // a dark outline around the seat keeps it readable against a light table top too
  p.puck({ x: seat.x - 1.5, y: seat.y - 1.5, w: s + 3, d: s + 3 }, 11, 13, 5, MONITOR);
  p.puck({ x: seat.x + 0.5, y: seat.y + 0.5, w: s - 1, d: s - 1 }, 13, 16, 4, CHAIR_SEAT);
  // the far armrest first, then the near one
  const [a1, a2] = arms[0].y - arms[0].x < arms[1].y - arms[1].x ? arms : [arms[1], arms[0]];
  p.box(a1, 16, 22, FURNITURE_DARK);
  p.box(a2, 16, 22, FURNITURE_DARK);
  if (backInFront) p.box(back, 14, 34, backColor);
}

/**
 * A desk with one work place per chair: a monitor on an arm, a keyboard and mouse in front of each person, and a
 * personal thing or two (a mug, a notebook, a small plant, a lamp), always the same for the same desk. A desk whose
 * people all sit on one side gets a privacy screen along its back edge (the banks of shared desks).
 */
function drawDesk(p: Painter, d: FurniturePiece, chairs: FurniturePiece[]): void {
  const b = { x: d.x, y: d.y, w: d.width, d: d.height };
  const mx = b.x + b.w / 2, my = b.y + b.d / 2;
  const sides = chairs.map((c) => snap({ x: c.x + c.width / 2 - mx, y: c.y + c.height / 2 - my }));
  const twoSided = sides.some((a) => sides.some((o) => o.x === -a.x && o.y === -a.y && (a.x !== 0 || a.y !== 0)));
  p.shadow(b, 3, 0.3);
  // legs: two panel ends
  const horizontal = sides.length === 0 || sides[0].y !== 0;
  if (horizontal) {
    p.box({ x: b.x + 2, y: b.y + 3, w: 3, d: b.d - 6 }, 0, 26, FURNITURE_DARK);
    p.box({ x: b.x + b.w - 5, y: b.y + 3, w: 3, d: b.d - 6 }, 0, 26, FURNITURE_DARK);
  } else {
    p.box({ x: b.x + 3, y: b.y + 2, w: b.w - 6, d: 3 }, 0, 26, FURNITURE_DARK);
    p.box({ x: b.x + 3, y: b.y + b.d - 5, w: b.w - 6, d: 3 }, 0, 26, FURNITURE_DARK);
  }
  p.box(b, 26, 29, TABLE_TOP);

  // privacy screen along the back edge when everyone faces the same way
  const one = sides[0];
  const screen: Box | null = one && !twoSided
    ? one.y > 0 ? { x: b.x + 2, y: b.y, w: b.w - 4, d: 3 }
      : one.y < 0 ? { x: b.x + 2, y: b.y + b.d - 3, w: b.w - 4, d: 3 }
      : one.x > 0 ? { x: b.x, y: b.y + 2, w: 3, d: b.d - 4 }
      : { x: b.x + b.w - 3, y: b.y + 2, w: 3, d: b.d - 4 }
    : null;
  const screenInFront = one ? one.y < 0 || one.x > 0 : false;
  if (screen && !screenInFront) p.box(screen, 29, 50, shade(FURNITURE_MID, 1.2));

  const places = chairs.length ? chairs.map((c, i) => ({ c, side: sides[i] })) : [];
  // back to front, so a nearer monitor covers a further one
  places.sort((u, v) => depthOf(u.c) - depthOf(v.c));
  for (const { c, side } of places) {
    const px = c.x + c.width / 2, py = c.y + c.height / 2;
    const along = side.y !== 0 ? { x: px, y: my } : { x: mx, y: py };
    const reach = side.y !== 0 ? b.d : b.w;
    const back = twoSided ? 5 : reach / 2 - 8; // monitor distance behind the desk's middle, away from the person
    const mw = Math.min(40, (side.y !== 0 ? b.w / Math.max(1, places.length) : b.d) * 0.62);
    const monX = along.x - side.x * back, monY = along.y - side.y * back;
    const monitor: Box = side.y !== 0 ? { x: monX - mw / 2, y: monY - 1.5, w: mw, d: 3 } : { x: monX - 1.5, y: monY - mw / 2, w: 3, d: mw };
    const front = twoSided ? reach / 4 + 2 : reach / 2 - 10; // keyboard toward the person
    const kx = along.x + side.x * (front - (twoSided ? 4 : 0)), ky = along.y + side.y * (front - (twoSided ? 4 : 0));
    const kb: Box = side.y !== 0 ? { x: kx - mw * 0.35, y: ky - 3, w: mw * 0.7, d: 6 } : { x: kx - 3, y: ky - mw * 0.35, w: 6, d: mw * 0.7 };
    const mouse = side.y !== 0 ? { x: kx + mw * 0.45, y: ky } : { x: kx, y: ky + mw * 0.45 };
    p.box({ x: monX - 2, y: monY - 2, w: 4, d: 4 }, 29, 30, FURNITURE_DARK); // monitor foot
    p.box({ x: monX - 1, y: monY - 1, w: 2, d: 2 }, 30, 36, FURNITURE_DARK); // arm
    p.box(kb, 29, 30.5, shade(FURNITURE_DARK, 1.3));
    p.disc(mouse.x, mouse.y, 30.5, 2, shade(FURNITURE_DARK, 1.3));
    p.box(monitor, 34, 50, MONITOR);
    // a glint on the screen so it reads as a display
    const glint: Box = side.y !== 0 ? { x: monitor.x + 2, y: monitor.y + (side.y > 0 ? monitor.d : -0.5), w: monitor.w - 4, d: 0.5 } : { x: monitor.x + (side.x > 0 ? monitor.w : -0.5), y: monitor.y + 2, w: 0.5, d: monitor.d - 4 };
    p.box(glint, 36, 48, SCREEN_GLOW, 0.6);
    // one personal thing beside the keyboard
    const thing = pick(c.id, 4);
    const sx = kx + (side.y !== 0 ? -mw * 0.55 : side.x * -6), sy = ky + (side.y !== 0 ? side.y * -6 : -mw * 0.55);
    if (thing === 0) { p.disc(sx, sy, 30, 2.6, FURNITURE_LIGHT); p.disc(sx, sy, 34, 2.4, WOOD); } // mug of coffee
    else if (thing === 1) p.box({ x: sx - 4, y: sy - 3, w: 8, d: 6 }, 29, 30.5, shade(WOOD, 1.3)); // notebook
    else if (thing === 2) { p.box({ x: sx - 2, y: sy - 2, w: 4, d: 4 }, 29, 33, FURNITURE_LIGHT); p.disc(sx, sy, 37, 3.5, FOLIAGE); } // small plant
  }
  if (screen && screenInFront) p.box(screen, 29, 50, shade(FURNITURE_MID, 1.2));
}

/**
 * A table: a pedestal and a rounded top; a narrow one is a high standing bar. Every chair at it gets an open laptop
 * and a glass of water in front of it, and a bigger table has a plant and a conference speaker in the middle.
 */
function drawTable(p: Painter, t: FurniturePiece, chairs: FurniturePiece[], round = false): void {
  const b = { x: t.x, y: t.y, w: t.width, d: t.height };
  const narrow = Math.min(b.w, b.d) < 40;
  const top = narrow ? 36 : 28;
  p.shadow(b, 4, 0.3);
  const inset = Math.min(b.w, b.d) * 0.3;
  p.box({ x: b.x + inset, y: b.y + inset, w: Math.max(4, b.w - inset * 2), d: Math.max(4, b.d - inset * 2) }, 0, top, FURNITURE_DARK);
  p.puck(b, top, top + 4, round ? b.w / 2 : Math.min(24, Math.min(b.w, b.d) / 2), TABLE_TOP);
  const z = top + 4;
  if (!narrow) {
    const cx = b.x + b.w / 2, cy = b.y + b.d / 2;
    p.disc(cx, cy, z, 7, FURNITURE_DARK); // conference speaker
    p.disc(cx, cy, z + 1, 5, shade(FURNITURE_DARK, 1.4));
    if (b.w > 150 || b.d > 150) {
      const off = Math.max(b.w, b.d) * 0.25;
      const [ox, oy] = b.w >= b.d ? [off, 0] : [0, off];
      for (const k of [-1, 1]) {
        p.box({ x: cx + k * ox - 3, y: cy + k * oy - 3, w: 6, d: 6 }, z, z + 5, FURNITURE_LIGHT);
        p.disc(cx + k * ox, cy + k * oy, z + 9, 5, FOLIAGE);
      }
    }
  }
  const sorted = [...chairs].sort((u, v) => depthOf(u) - depthOf(v));
  for (const c of sorted) {
    const px = c.x + c.width / 2, py = c.y + c.height / 2;
    const nx = Math.max(b.x + 10, Math.min(px, b.x + b.w - 10)), ny = Math.max(b.y + 10, Math.min(py, b.y + b.d - 10));
    const side = snap({ x: px - nx, y: py - ny }); // from the table toward the person
    const lx = nx - side.x * 2, ly = ny - side.y * 2;
    const lap: Box = side.y !== 0 ? { x: lx - 7, y: ly - 4.5, w: 14, d: 9 } : { x: lx - 4.5, y: ly - 7, w: 9, d: 14 };
    p.box(lap, z, z + 1, shade(FURNITURE_LIGHT, 1.1));
    // the lid stands up on the far edge, facing the person
    const lid: Box = side.y !== 0
      ? { x: lap.x, y: side.y > 0 ? lap.y - 1 : lap.y + lap.d, w: lap.w, d: 1 }
      : { x: side.x > 0 ? lap.x - 1 : lap.x + lap.w, y: lap.y, w: 1, d: lap.d };
    p.box(lid, z + 1, z + 10, MONITOR);
    const gx = lx + (side.y !== 0 ? 11 : side.x * 5), gy = ly + (side.y !== 0 ? side.y * 5 : 11);
    p.disc(gx, gy, z, 2, GLASS, 0.5);
    p.disc(gx, gy, z + 5, 2, GLASS, 0.7);
  }
}

/** A sofa: a base, a back rest, rolled arms, one cushion per seat and a couple of throw pillows, facing `facing`. */
function drawSofa(p: Painter, s: FurniturePiece, facing: Point): void {
  const b = { x: s.x, y: s.y, w: s.width, d: s.height };
  p.shadow(b, 4, 0.32);
  const t = Math.min(b.w, b.d) * 0.3;
  const horizontal = b.w >= b.d;
  const back: Box = horizontal
    ? { x: b.x, y: facing.y > 0 ? b.y - t : b.y + b.d, w: b.w, d: t }
    : { x: facing.x > 0 ? b.x - t : b.x + b.w, y: b.y, w: t, d: b.d };
  const armW = 7;
  const arms: Box[] = horizontal
    ? [{ x: b.x - armW, y: Math.min(b.y, back.y), w: armW, d: b.d + t }, { x: b.x + b.w, y: Math.min(b.y, back.y), w: armW, d: b.d + t }]
    : [{ x: Math.min(b.x, back.x), y: b.y - armW, w: b.w + t, d: armW }, { x: Math.min(b.x, back.x), y: b.y + b.d, w: b.w + t, d: armW }];
  const backInFront = facing.y < 0 || facing.x > 0;
  const upholstery = shade(FURNITURE_MID, 1.05);
  // short legs under the corners
  for (const [lx, ly] of [[b.x, b.y], [b.x + b.w - 3, b.y], [b.x, b.y + b.d - 3], [b.x + b.w - 3, b.y + b.d - 3]]) p.box({ x: lx, y: ly, w: 3, d: 3 }, 0, 3, WOOD);
  if (!backInFront) p.box(back, 3, 32, upholstery);
  p.box(arms[0], 3, 22, upholstery);
  p.box(b, 3, 13, shade(FURNITURE_MID, 0.9));
  const n = Math.max(1, Math.round((horizontal ? b.w : b.d) / 40));
  for (let i = 0; i < n; i++) {
    const cushion = horizontal
      ? { x: b.x + (b.w / n) * i + 1.5, y: b.y + 1.5, w: b.w / n - 3, d: b.d - 3 }
      : { x: b.x + 1.5, y: b.y + (b.d / n) * i + 1.5, w: b.w - 3, d: b.d / n - 3 };
    p.puck(cushion, 13, 17, 3, shade(FURNITURE_LIGHT, 0.9));
  }
  // two throw pillows leaning on the back rest at the ends
  const pillow = (f: number, color: number) => {
    const along = horizontal ? { x: b.x + b.w * f - 6, y: facing.y > 0 ? b.y + 1 : b.y + b.d - 5, w: 12, d: 4 } : { x: facing.x > 0 ? b.x + 1 : b.x + b.w - 5, y: b.y + b.d * f - 6, w: 4, d: 12 };
    p.box(along, 17, 27, color);
  };
  pillow(0.15, WOOD);
  pillow(0.85, shade(FURNITURE_LIGHT, 1.1));
  p.box(arms[1], 3, 22, upholstery);
  if (backInFront) p.box(back, 3, 32, upholstery);
}

/**
 * The kitchen counter: cabinets with doors and handles, a stone top, a sink with a tap, a coffee machine with cups,
 * plates of food, a fruit bowl and a water dispenser, spaced along its length.
 */
function drawCounter(p: Painter, c: FurniturePiece): void {
  const b = { x: c.x, y: c.y, w: c.width, d: c.height };
  p.shadow(b, 3, 0.32);
  p.box(b, 0, 34, FURNITURE_DARK);
  const long = b.w >= b.d;
  const len = long ? b.w : b.d;
  const depth = long ? b.d : b.w;
  // cabinet doors: thin lighter strips on the front face with a handle each
  const doors = Math.max(2, Math.floor(len / 32));
  for (let i = 0; i < doors; i++) {
    const f = (i + 0.5) / doors;
    const h: Box = long ? { x: b.x + len * f - 4, y: b.y + b.d, w: 8, d: 0.6 } : { x: b.x - 0.6, y: b.y + len * f - 4, w: 0.6, d: 8 };
    p.box(h, 26, 28, FURNITURE_LIGHT);
    const seam: Box = long ? { x: b.x + (len * i) / doors, y: b.y + b.d, w: 0.8, d: 0.4 } : { x: b.x - 0.4, y: b.y + (len * i) / doors, w: 0.4, d: 0.8 };
    if (i > 0) p.box(seam, 2, 32, MONITOR);
  }
  p.box({ x: b.x - 1, y: b.y - 1, w: b.w + 2, d: b.d + 2 }, 34, 37, FURNITURE_LIGHT);
  const along = (f: number, size: number, dd: number): Box =>
    long ? { x: b.x + len * f, y: b.y + (b.d - dd) / 2, w: size, d: dd } : { x: b.x + (b.w - dd) / 2, y: b.y + len * f, w: dd, d: size };
  const d2 = Math.max(6, depth - 4);
  // coffee machine and two cups
  const cm = along(0.03, 20, Math.min(14, d2));
  p.box(cm, 37, 58, MONITOR);
  p.box({ x: cm.x + 3, y: cm.y + cm.d - 1, w: cm.w - 6, d: 1 }, 44, 52, SCREEN_GLOW, 0.8);
  for (const f of [0.1, 0.13]) { const cup = along(f, 5, 5); p.disc(cup.x + 2.5, cup.y + 2.5, 37, 2.4, FURNITURE_LIGHT); p.disc(cup.x + 2.5, cup.y + 2.5, 41, 2.2, WOOD); }
  // sink with a tap
  const sink = along(0.2, 26, Math.min(14, d2));
  p.box(sink, 36.5, 37.2, shade(FURNITURE_DARK, 1.5));
  p.box({ x: sink.x + sink.w / 2 - 1, y: sink.y - (long ? 0 : 0), w: 2, d: 2 }, 37, 46, FURNITURE_LIGHT);
  // plates of food
  for (const f of [0.32, 0.4, 0.48, 0.56]) {
    const pl = along(f, 14, 14);
    p.disc(pl.x + 7, pl.y + 7, 37, 7, FURNITURE_LIGHT);
    p.disc(pl.x + 7, pl.y + 7, 38, 4.5, WOOD);
  }
  // fruit bowl
  const fb = along(0.66, 16, 16);
  p.disc(fb.x + 8, fb.y + 8, 37, 8, FURNITURE_DARK);
  for (const [dx, dy, col] of [[-3, -1, FRUIT_YELLOW], [2, -2, FRUIT_RED], [0, 2, FRUIT_GREEN]] as const) p.disc(fb.x + 8 + dx, fb.y + 8 + dy, 41, 3, col);
  // water dispenser
  const w = along(0.86, 12, 12);
  p.box(w, 37, 44, FURNITURE_LIGHT);
  p.box({ x: w.x + 1, y: w.y + 1, w: w.w - 2, d: w.d - 2 }, 44, 62, GLASS, 0.8);
}

function drawPlant(p: Painter, pl: FurniturePiece): void {
  const cx = pl.x + pl.width / 2, cy = pl.y + pl.height / 2, r = Math.min(pl.width, pl.height) / 2;
  const kind = pick(pl.id, 3);
  p.shadow({ x: cx - r, y: cy - r, w: r * 2, d: r * 2 }, 3, 0.3);
  p.disc(cx, cy, 0, r * 0.62, FURNITURE_DARK);
  p.puck({ x: cx - r * 0.6, y: cy - r * 0.6, w: r * 1.2, d: r * 1.2 }, 0, 14, r * 0.6, kind === 1 ? FURNITURE_LIGHT : FURNITURE_DARK);
  p.disc(cx, cy, 14, r * 0.5, shade(WOOD, 0.6)); // soil
  if (kind === 1) {
    // tall leafy plant: a stem and leaves fanning out at several heights
    p.box({ x: cx - 1, y: cy - 1, w: 2, d: 2 }, 14, 50, shade(FOLIAGE, 0.7));
    for (let i = 0; i < 7; i++) {
      const a = i * 2.4, h = 22 + i * 4;
      p.disc(cx + Math.cos(a) * r * 0.55, cy + Math.sin(a) * r * 0.55, h, r * 0.45, shade(FOLIAGE, 0.85 + (i % 3) * 0.12));
    }
    return;
  }
  const big = kind === 0 ? 1.1 : 0.8;
  p.disc(cx, cy, 18, r * big, shade(FOLIAGE, 0.75));
  p.disc(cx - r * 0.3, cy + r * 0.2, 24, r * 0.85 * big, FOLIAGE);
  p.disc(cx + r * 0.3, cy - r * 0.1, 28, r * 0.7 * big, shade(FOLIAGE, 1.1));
  p.disc(cx, cy - r * 0.1, 33, r * 0.45 * big, shade(FOLIAGE, 1.25));
}

export function drawPiece3d(p: Painter, piece: FurniturePiece, all: FurniturePiece[]): void {
  const b = { x: piece.x, y: piece.y, w: piece.width, d: piece.height };
  switch (piece.kind) {
    case "chair":
      return drawChair(p, piece, facingOf(piece, all));
    case "desk":
      return drawDesk(p, piece, chairsAt(piece, all));
    case "table":
      return drawTable(p, piece, chairsAt(piece, all), isRoundTable(piece, all));
    case "sofa":
      return drawSofa(p, piece, sofaFacing(piece, all));
    case "counter":
      return drawCounter(p, piece);
    case "plant":
      return drawPlant(p, piece);
    case "screen": {
      // a TV on a stand: foot, post, bezel and a softly lit screen
      p.box({ x: b.x + b.w * 0.3, y: b.y - 4, w: b.w * 0.4, d: b.d + 8 }, 0, 2, FURNITURE_DARK);
      p.box({ x: b.x + b.w * 0.47, y: b.y, w: b.w * 0.06, d: b.d }, 2, 30, FURNITURE_DARK);
      p.box(b, 30, 74, MONITOR);
      return p.box({ x: b.x + 2, y: b.y + b.d, w: b.w - 4, d: 0.5 }, 33, 71, SCREEN_GLOW, 0.9);
    }
    case "stage": {
      // a raised platform with a front step, a lectern with a microphone and two floor lights
      p.shadow(b, 4, 0.35);
      p.box(b, 0, 12, FURNITURE_DARK);
      p.box({ x: b.x + 2, y: b.y + 2, w: b.w - 4, d: b.d - 4 }, 12, 12.5, shade(FURNITURE_DARK, 1.25));
      p.box({ x: b.x + b.w * 0.35, y: b.y + b.d, w: b.w * 0.3, d: 8 }, 0, 6, shade(FURNITURE_DARK, 1.15));
      const lx = b.x + b.w * 0.72, ly = b.y + b.d * 0.4;
      p.box({ x: lx, y: ly, w: 18, d: 12 }, 12, 42, FURNITURE_MID);
      p.box({ x: lx - 1, y: ly - 1, w: 20, d: 14 }, 42, 44, FURNITURE_LIGHT);
      p.line(lx + 9, ly + 12, 44, lx + 9, ly + 16, 52, 1.2, FURNITURE_DARK);
      p.disc(lx + 9, ly + 16, 52, 1.8, MONITOR);
      for (const f of [0.1, 0.9]) {
        p.box({ x: b.x + b.w * f - 4, y: b.y + b.d - 10, w: 8, d: 8 }, 12, 18, MONITOR);
        p.disc(b.x + b.w * f, b.y + b.d - 6, 18, 3, FRUIT_YELLOW, 0.7);
      }
      return;
    }
    case "whiteboard": {
      // a whiteboard on legs with a marker tray and a couple of markers
      p.box({ x: b.x, y: b.y, w: b.w, d: 2 }, 0, 18, FURNITURE_DARK);
      p.box({ x: b.x, y: b.y + b.d - 2, w: b.w, d: 2 }, 0, 18, FURNITURE_DARK);
      p.box(b, 18, 72, WHITEBOARD);
      p.box({ x: b.x - 2, y: b.y, w: 2, d: b.d }, 22, 24, FURNITURE_MID);
      p.disc(b.x - 1, b.y + b.d * 0.3, 24, 1.3, FRUIT_RED);
      return p.disc(b.x - 1, b.y + b.d * 0.35, 24, 1.3, SCREEN_GLOW);
    }
    case "wall":
      return p.box(b, 0, 64, PARTITION);
    case "door":
      return p.box(b, 0, 4, FURNITURE_DARK);
    default:
      return p.box(b, 0, 20, FURNITURE_MID);
  }
}

/** A sofa faces the table or the open side nearest it; failing that, down the screen. */
function sofaFacing(s: FurniturePiece, all: FurniturePiece[]): Point {
  const horizontal = s.width >= s.height;
  const cx = s.x + s.width / 2, cy = s.y + s.height / 2;
  let best: { v: number; dist: number } | null = null;
  for (const f of all) {
    if (f === s || (f.kind !== "table" && f.kind !== "sofa" && f.kind !== "screen") || !sameArea(s, f)) continue;
    const dx = f.x + f.width / 2 - cx, dy = f.y + f.height / 2 - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < 220 && (!best || dist < best.dist)) best = { v: horizontal ? Math.sign(dy) : Math.sign(dx), dist };
  }
  const v = best?.v || 1;
  return horizontal ? { x: 0, y: v } : { x: v, y: 0 };
}

/** A square table with more than four chairs all round it is a round table (roundTable); a square one with four is
 *  a bench table (benchTable). */
function isRoundTable(t: FurniturePiece, all: FurniturePiece[]): boolean {
  if (Math.abs(t.width - t.height) > 1) return false;
  const cx = t.x + t.width / 2, cy = t.y + t.height / 2, reach = t.width / 2 + 60;
  return all.filter((c) => c.kind === "chair" && Math.hypot(c.x + c.width / 2 - cx, c.y + c.height / 2 - cy) < reach).length > 4;
}

/** The chairs pulled up to a desk or table: the ones whose nearest desk or table is this one. */
function chairsAt(piece: FurniturePiece, all: FurniturePiece[]): FurniturePiece[] {
  return all.filter((c) => {
    if (c.kind !== "chair" || gap(c, piece) > 24 || !sameArea(c, piece)) return false;
    for (const o of all) {
      if (o !== piece && (o.kind === "desk" || o.kind === "table") && sameArea(c, o) && gap(c, o) < gap(c, piece)) return false;
    }
    return true;
  });
}

function gap(a: FurniturePiece, b: FurniturePiece): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

/** Back-to-front order on the tilted floor: further down the screen is further forward. */
export function depthOf(piece: FurniturePiece): number {
  return piece.y + piece.height / 2 - (piece.x + piece.width / 2);
}

/**
 * Walls around a closed room (a private cabin or a meeting room), the first design the owner picked: solid walls on
 * the two far sides, glass with a dark frame on the two near sides so the people inside stay visible, and a door gap
 * in the front glass. Drawing only; a wall never blocks walking or sitting.
 */
export function drawRoomWalls(p: Painter, zone: LayoutZone, rect: { x: number; y: number; width: number; height: number }, phase: "back" | "front"): void {
  if (zone.kind !== "cabin" && zone.kind !== "meeting") return;
  const { x, y, width: w, height: d } = rect;
  const t = 6, h = zone.kind === "cabin" ? 60 : 52;
  if (phase === "back") {
    p.box({ x, y, w, d: t }, 0, h, PARTITION); // far side (-y)
    p.box({ x: x + w - t, y, w: t, d }, 0, h, PARTITION); // far side (+x)
    // a skirting strip and a picture rail make the solid walls read as real walls
    p.box({ x, y: y + t, w: w - t, d: 2 }, 0, 4, shade(PARTITION, 1.4));
    p.box({ x: x + w - t - 2, y: y + t, w: 2, d: d - t }, 0, 4, shade(PARTITION, 1.4));
    return;
  }
  const door = Math.min(56, w * 0.3);
  const glass = (b: Box) => {
    p.box(b, 0, h, GLASS, 0.14);
    p.box(b, h - 3, h, PARTITION);
    p.box(b, 0, 3, PARTITION);
  };
  glass({ x, y, w: t, d }); // near side (-x)
  // near side (+y), with a door gap in the middle
  const left = (w - door) / 2;
  glass({ x, y: y + d - t, w: left, d: t });
  glass({ x: x + left + door, y: y + d - t, w: w - left - door, d: t });
  p.box({ x: x + left, y: y + d - t, w: door, d: t }, h - 3, h, PARTITION); // door head
}
