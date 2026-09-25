import { Container, Graphics } from "pixi.js";
import { TILE_PX, zoneAt, type FurniturePiece, type RoomLayout } from "@workspace-video/shared";
import { liftVector, screenStep } from "./lift";
import { FLOOR_MARGIN } from "./viewportMath";
import { planFloor, type Box, type FloorPlan, type SlabPlan } from "./slabPlan";
import { BLACK, CONCRETE, CONCRETE_EDGE, FLOOR_BORDER, LINE } from "./palette";
import { Painter, depthOf, drawPiece3d, drawRoomWalls, setZonesOf } from "./furniture3d";
import { buildGridOverlay } from "./GridOverlay";

/**
 * The office floor: a layout's areas and furniture, drawn once in the Gemini design's look (charcoal panels, soft
 * white outlines, one amber accent; docs/designs/gemini-landing.html.html). Built ONCE from the layout and never
 * touched by the per-frame render loop; this is the whole point of keeping furniture out of objectsStore (see the
 * Phase 8 plan's rendering section). Seat occupancy (who's sitting where) is a separate, small overlay added on top
 * (SeatOverlay.ts): this module only draws the room as it exists at rest.
 */

// Nearly solid, so the shadow under a raised area does not show through it.
const PANEL_FILL_ALPHA = 0.92;
// How far the shadow sits down and to the left of an area at rest, on the screen. Raising the area pushes it further.
const REST_SHADOW_OFFSET = 6;
// How thick a slab looks, in screen pixels before zoom: the strip of side wall seen below its top face.
const AREA_THICKNESS = 8;
const GROUP_THICKNESS = 5;

function drawPanel(layer: Container, box: Box, radius: number): void {
  layer.addChild(
    new Graphics()
      .roundRect(box.x, box.y, box.width, box.height, radius)
      .fill({ color: CONCRETE, alpha: PANEL_FILL_ALPHA })
      .stroke({ width: 1.5, color: LINE, alpha: 0.06 }),
  );
}

/**
 * One plate of the floor: its top, the furniture standing on it, and (for a whole area) its name move up together
 * when it is raised. It has a visible thickness and casts a soft shadow that stays on the floor and grows as the plate
 * rises (the Gemini map's platforms).
 */
class FloorSlab {
  readonly container = new Container();
  readonly shadow: Graphics;

  /** `depth` orders plates back to front, so a plate's side wall never covers one standing in front of it. */
  constructor(
    plan: SlabPlan,
    private readonly depth: number,
    private readonly tilted: boolean,
  ) {
    const box = plan.rect;
    const radius = plan.isGroup ? 10 : 16;
    const thickness = plan.isGroup ? GROUP_THICKNESS : AREA_THICKNESS;
    // The side wall: the same outline, pushed straight down the screen, drawn first so the top face covers most of it.
    const wall = screenStep(0, thickness, tilted);
    this.container.addChild(
      new Graphics()
        .roundRect(box.x + wall.x, box.y + wall.y, box.width, box.height, radius)
        .fill(CONCRETE_EDGE)
        .stroke({ width: 1.5, color: LINE, alpha: 0.08 }),
    );
    drawPanel(this.container, box, radius);

    this.shadow = new Graphics();
    // Three stacked, slightly larger copies with faint fills make a soft edge without a blur filter (which is costly).
    for (const [grow, alpha] of [[14, 0.12], [8, 0.16], [2, 0.22]] as const) {
      this.shadow.roundRect(box.x - grow, box.y - grow, box.width + grow * 2, box.height + grow * 2, radius + grow).fill({ color: BLACK, alpha });
    }
    this.setLift(0);
  }

  /** Raises the plate by `height` (how much higher it appears on the screen, before zoom). */
  setLift(height: number): void {
    const step = liftVector(height, this.tilted);
    this.container.position.set(step.x, step.y);
    // Back to front at rest; above everything for as long as it is off the floor.
    this.container.zIndex = this.depth + (height > 0 ? 1000 : 0);
    const away = REST_SHADOW_OFFSET + height * 0.6;
    const offset = screenStep(-away, away, this.tilted);
    this.shadow.position.set(offset.x, offset.y);
    this.shadow.alpha = Math.min(1, 0.7 + height * 0.02);
  }
}

export interface FloorView {
  container: Container;
  /** How the floor was cut into plates; the stage uses it to find the plate under the mouse, under a person, under a seat. */
  plan: FloorPlan;
  /** Raises one plate by that much (0 puts it back on the floor). Plates that do not exist are ignored. */
  setLift(slabId: string, height: number): void;
}

const DECOR_KINDS = new Set(["plant", "screen", "whiteboard"]);
const DECOR_MARGIN = 6;

function keepInside(piece: FurniturePiece, rect: Box): FurniturePiece {
  const x = Math.min(Math.max(piece.x, rect.x + DECOR_MARGIN), rect.x + rect.width - DECOR_MARGIN - piece.width);
  const y = Math.min(Math.max(piece.y, rect.y + DECOR_MARGIN), rect.y + rect.height - DECOR_MARGIN - piece.height);
  return x === piece.x && y === piece.y ? piece : { ...piece, x, y };
}

export function buildFloorView(layout: RoomLayout, tilted = true): FloorView {
  const plan = planFloor(layout);
  const container = new Container();
  const shadows = new Container();
  const slabLayer = new Container();
  slabLayer.sortableChildren = true;
  const loose = new Container(); // furniture that stands on no plate
  // One concrete floor under everything, like the reference render; the plates sit on it.
  const size = { width: layout.floor.cols * TILE_PX, height: layout.floor.rows * TILE_PX };
  const base = new Graphics();
  const edge = screenStep(0, AREA_THICKNESS * 2, tilted);
  // The floor is drawn FLOOR_MARGIN wider than the layout on every side, so a chair at the layout's edge still has
  // floor around it (the viewport fits this margin in too).
  const m = FLOOR_MARGIN;
  base.rect(-m + edge.x, -m + edge.y, size.width + m * 2, size.height + m * 2).fill(CONCRETE_EDGE);
  base.rect(-m, -m, size.width + m * 2, size.height + m * 2).fill(CONCRETE).stroke({ width: 3, color: FLOOR_BORDER });
  // A faint reference grid on the real tile unit (TILE_PX), on top of the floor and beneath every
  // plate/furniture layer - purely additive, see GridOverlay.ts. Does not touch any layout file.
  const grid = buildGridOverlay(layout.floor.cols, layout.floor.rows);
  container.addChild(base, grid, shadows, slabLayer, loose);
  const zoneById = new Map(layout.zones.map((z) => [z.id, z]));
  const pieceZone = new Map(layout.furniture.map((f) => [f.id, zoneAt(layout, { x: f.x + f.width / 2, y: f.y + f.height / 2 })?.id ?? null]));
  setZonesOf((piece) => pieceZone.get(piece.id) ?? null);
  const drawPieces = (layer: Container, indices: number[], zoneId: string | null, rect: Box | null) => {
    const g = new Graphics();
    const painter = new Painter(g, tilted);
    const zone = zoneId ? zoneById.get(zoneId) : undefined;
    if (zone && rect) drawRoomWalls(painter, zone, rect, "back");
    // Decorations with no seat (plants, screens, whiteboards) are nudged inside the drawn plate, which is inset from
    // the area's edge; a module may place them right on that edge. Pieces people sit at are never moved.
    const pieces = indices
      .map((i) => (rect && DECOR_KINDS.has(layout.furniture[i].kind) ? keepInside(layout.furniture[i], rect) : layout.furniture[i]))
      .sort((a, b) => depthOf(a) - depthOf(b));
    for (const piece of pieces) drawPiece3d(painter, piece, layout.furniture);
    if (zone && rect) drawRoomWalls(painter, zone, rect, "front");
    layer.addChild(g);
  };

  // On the screen, further down means further forward: that is where y grows and x shrinks on the flat floor.
  const centreDepth = (r: Box) => r.y + r.height / 2 - (r.x + r.width / 2);
  const backToFront = [...plan.slabs].sort((a, b) => centreDepth(a.rect) - centreDepth(b.rect));
  const slabs = new Map<string, FloorSlab>();
  for (const slabPlan of plan.slabs) {
    const slab = new FloorSlab(slabPlan, backToFront.indexOf(slabPlan), tilted);
    slabs.set(slabPlan.id, slab);
    shadows.addChild(slab.shadow);
    slabLayer.addChild(slab.container);
    drawPieces(slab.container, slabPlan.pieces, slabPlan.isGroup ? null : slabPlan.zoneId, slabPlan.rect);
  }
  drawPieces(loose, plan.loosePieces, null, null);

  return {
    container,
    plan,
    setLift(slabId, height) {
      slabs.get(slabId)?.setLift(height);
    },
  };
}
