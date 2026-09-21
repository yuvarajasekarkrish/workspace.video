import type { FurniturePiece, LayoutZone, Point, RoomLayout } from "@workspace-video/shared";
import { tileRectToWorld, zoneAt } from "@workspace-video/shared";

/**
 * How the floor is drawn as raisable plates, like the Gemini map: an area with several desks or tables is shown as
 * one small plate per desk group with empty floor between them; an area with one or two pieces (a plaza, a meeting
 * room) stays one plate. This is only about drawing. The layout, the seats and the engine are not touched, and any
 * template goes through the same rule.
 */

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SlabPlan {
  /** The area's own id for a whole-area plate, or "<area id>#<n>" for one desk group. */
  id: string;
  zoneId: string;
  /** Where the plate is on the flat floor. */
  rect: Box;
  /** Positions in layout.furniture of the pieces standing on this plate. */
  pieces: number[];
  /** True for one desk group cut out of a bigger area (drawn smaller and thinner). */
  isGroup: boolean;
}

export interface FloorPlan {
  slabs: SlabPlan[];
  /** Furniture that stands on no plate (drawn flat on the floor). */
  loosePieces: number[];
  /** Areas drawn as separate groups: their name lies on the floor, not on a plate. */
  splitZoneIds: Set<string>;
}

/** Furniture people sit at or around; an area needs at least MIN_SEEDS_TO_SPLIT of these to be split into groups. */
const SEED_KINDS = new Set<string>(["desk", "table", "sofa", "counter"]);
export const MIN_SEEDS_TO_SPLIT = 3;
/** Two desks closer than this belong to one group. */
const MERGE_GAP = 20;
/** A chair joins the nearest desk if it is this close; anything else standing near a desk (a screen, a plant) if this close. */
const CHAIR_REACH = 60;
const OTHER_REACH = 80;
/** How far a group's plate reaches beyond its furniture. Small, so neighbouring groups keep a gap between them. */
export const GROUP_PAD = 8;
/** A whole-area plate is drawn this much smaller on every side, so neighbouring areas do not touch. */
export const AREA_INSET = 12;

function gap(a: Box, b: Box): number {
  const dx = Math.max(0, a.x - (b.x + b.width), b.x - (a.x + a.width));
  const dy = Math.max(0, a.y - (b.y + b.height), b.y - (a.y + a.height));
  return Math.hypot(dx, dy);
}

function bounds(boxes: Box[]): Box {
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.width));
  const y1 = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function inside(outer: Box, inner: Box): Box {
  const x0 = Math.max(outer.x, inner.x);
  const y0 = Math.max(outer.y, inner.y);
  const x1 = Math.min(outer.x + outer.width, inner.x + inner.width);
  const y1 = Math.min(outer.y + outer.height, inner.y + inner.height);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function pointIn(box: Box, p: Point): boolean {
  return p.x >= box.x && p.x < box.x + box.width && p.y >= box.y && p.y < box.y + box.height;
}

function wholeArea(zone: LayoutZone, pieces: number[]): SlabPlan {
  const box = tileRectToWorld(zone.rect);
  return {
    id: zone.id,
    zoneId: zone.id,
    rect: { x: box.x + AREA_INSET, y: box.y + AREA_INSET, width: box.width - AREA_INSET * 2, height: box.height - AREA_INSET * 2 },
    pieces,
    isGroup: false,
  };
}

/** Cuts one area with several desks into desk groups. Returns null when the area should stay one plate. */
function splitArea(zone: LayoutZone, indices: number[], furniture: FurniturePiece[]): { groups: SlabPlan[]; loose: number[] } | null {
  const seeds = indices.filter((i) => SEED_KINDS.has(furniture[i].kind));
  if (seeds.length < MIN_SEEDS_TO_SPLIT) return null;

  // Desks that touch or nearly touch are one group.
  const parent = new Map<number, number>(seeds.map((i) => [i, i]));
  const find = (i: number): number => {
    let root = i;
    while (parent.get(root) !== root) root = parent.get(root)!;
    return root;
  };
  for (let a = 0; a < seeds.length; a++) {
    for (let b = a + 1; b < seeds.length; b++) {
      if (gap(furniture[seeds[a]], furniture[seeds[b]]) <= MERGE_GAP) parent.set(find(seeds[a]), find(seeds[b]));
    }
  }

  // Everything else goes with its nearest desk, if one is close enough.
  const members = new Map<number, number[]>();
  for (const seed of seeds) members.set(find(seed), [...(members.get(find(seed)) ?? []), seed]);
  const loose: number[] = [];
  for (const i of indices) {
    if (SEED_KINDS.has(furniture[i].kind)) continue;
    const reach = furniture[i].kind === "chair" ? CHAIR_REACH : OTHER_REACH;
    let best: { seed: number; distance: number } | null = null;
    for (const seed of seeds) {
      const distance = gap(furniture[i], furniture[seed]);
      if (distance <= reach && (best === null || distance < best.distance)) best = { seed, distance };
    }
    if (best) members.get(find(best.seed))!.push(i);
    else loose.push(i);
  }

  const zoneBox = tileRectToWorld(zone.rect);
  const groups: SlabPlan[] = [...members.values()].map((pieces) => {
    const around = bounds(pieces.map((i) => furniture[i]));
    const padded = { x: around.x - GROUP_PAD, y: around.y - GROUP_PAD, width: around.width + GROUP_PAD * 2, height: around.height + GROUP_PAD * 2 };
    return { id: "", zoneId: zone.id, rect: inside(zoneBox, padded), pieces, isGroup: true };
  });
  // A steady order (top to bottom, left to right) so a group keeps the same id every time the floor is planned.
  groups.sort((a, b) => a.rect.y - b.rect.y || a.rect.x - b.rect.x);
  groups.forEach((g, n) => (g.id = `${zone.id}#${n}`));
  return { groups, loose };
}

export function planFloor(layout: RoomLayout): FloorPlan {
  const byZone = new Map<string, number[]>();
  const loosePieces: number[] = [];
  layout.furniture.forEach((piece, i) => {
    const owner = zoneAt(layout, { x: piece.x + piece.width / 2, y: piece.y + piece.height / 2 });
    if (!owner) loosePieces.push(i);
    else byZone.set(owner.id, [...(byZone.get(owner.id) ?? []), i]);
  });

  const slabs: SlabPlan[] = [];
  const splitZoneIds = new Set<string>();
  for (const zone of layout.zones) {
    const indices = byZone.get(zone.id) ?? [];
    const split = splitArea(zone, indices, layout.furniture);
    if (split) {
      splitZoneIds.add(zone.id);
      slabs.push(...split.groups);
      loosePieces.push(...split.loose);
    } else {
      slabs.push(wholeArea(zone, indices));
    }
  }
  return { slabs, loosePieces, splitZoneIds };
}

/** The plate a floor position is on, or null. Where plates overlap, the smaller one wins. */
export function slabAt(plan: FloorPlan, point: Point): SlabPlan | null {
  let best: SlabPlan | null = null;
  for (const slab of plan.slabs) {
    if (!pointIn(slab.rect, point)) continue;
    if (best === null || slab.rect.width * slab.rect.height < best.rect.width * best.rect.height) best = slab;
  }
  return best;
}
