import { Container, Graphics, Matrix, Text } from "pixi.js";
import type { RoomLayout, FurniturePiece, LayoutZone } from "@workspace-video/shared";
import { tileRectToWorld } from "@workspace-video/shared";
import { liftVector, screenStep } from "./lift";
import { zoomFloorMatrix } from "./isoMath";
import { planFloor, type Box, type FloorPlan, type SlabPlan } from "./slabPlan";
import { ACCENT, BLACK, CHAIR_FILL, LINE, PANEL_FILL, PLANT_GREEN, SLAB_EDGE, WHITE } from "./palette";

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
const AREA_THICKNESS = 14;
const GROUP_THICKNESS = 9;

// An area name's own authored font size (Text style, below) — the size it renders at when the map's
// zoom is 1 or above, and the reference `MIN_ZONE_LABEL_PX` is measured against. Smaller than
// DESIGN.md's general 16 px floor: the owner's own correction (2026-09-22) — a full 16 px looked
// oversized and sudden next to the map's natural fit zoom.
const ZONE_LABEL_FONT_SIZE = 14;
// The smallest an area name may ever render at on screen, however far the map is zoomed out (a
// floor, not a fixed pin — see zoomFloorMatrix).
const MIN_ZONE_LABEL_PX = 10;
// The zoom at which a ZONE_LABEL_FONT_SIZE-authored label already renders at MIN_ZONE_LABEL_PX — the
// `floorAt` zoomFloorMatrix needs, derived from the two pixel sizes above rather than a made-up zoom
// number, so the two constants above are the only place this policy has to be tuned again.
const ZONE_LABEL_FLOOR_AT = MIN_ZONE_LABEL_PX / ZONE_LABEL_FONT_SIZE;

function drawPanel(layer: Container, box: Box, radius: number): void {
  layer.addChild(
    new Graphics()
      .roundRect(box.x, box.y, box.width, box.height, radius)
      .fill({ color: PANEL_FILL, alpha: PANEL_FILL_ALPHA })
      .stroke({ width: 2, color: LINE, alpha: 0.1 }),
  );
}

/** The area's name lies quietly in its bottom-right corner, as on the Gemini map, tilted with the
 *  floor exactly as before and scaling with the map's own zoom exactly like everything else — down
 *  to MIN_ZONE_LABEL_PX, below which it stops shrinking further (see zoomFloorMatrix). Two nested
 *  containers, each doing exactly one job, so `setZoom` can never disturb where the label sits:
 *   - `anchor` — carries ONLY the position (in floor coordinates), so it lands in the right area's
 *     corner exactly as before, at any pan or zoom.
 *   - `billboard` (its child) — carries ONLY the counter-scale `setZoom` writes with
 *     `setFromMatrix` (which resets a container's full local transform, position included — the
 *     reason this needs to be its own container and not the same one `anchor` uses). */
function drawZoneLabel(layer: Container, zone: LayoutZone, corner: Box): Container {
  const anchor = new Container();
  anchor.position.set(corner.x + corner.width - 22, corner.y + corner.height - 16);
  const billboard = new Container();
  anchor.addChild(billboard);
  const label = new Text({
    text: zone.label,
    style: {
      fill: WHITE,
      fontSize: ZONE_LABEL_FONT_SIZE,
      // A thin weight (used to be 300) with wide spacing (used to be 2) reads fine flat and
      // horizontal, but goes faint and blurry once Pixi tilts it — the actual cause the owner
      // spotted comparing it to a crisp, un-tilted DOM chip (2026-09-26). Matching a person's own
      // name tag (Avatar.ts uses 500/600) fixes it at the source instead of fighting it with alpha.
      letterSpacing: 0.5,
      fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif",
      fontWeight: "500",
    },
  });
  // Full brightness, matching a person's name tag (Avatar.ts, which sets no alpha at all) — the
  // owner's own correction (2026-09-22): the label had been drawn quiet on purpose, but at this
  // size it just looked dim rather than deliberately understated.
  label.anchor.set(1, 1);
  billboard.addChild(label);
  layer.addChild(anchor);
  return billboard;
}

function drawFurniturePiece(layer: Container, piece: FurniturePiece): void {
  const { x, y, width, height } = piece;
  const g = new Graphics();

  switch (piece.kind) {
    case "chair": {
      g.circle(x + width / 2, y + height / 2, width / 2).fill(CHAIR_FILL).stroke({ width: 1.5, color: LINE, alpha: 0.15 });
      break;
    }
    case "plant": {
      g.circle(x + width / 2, y + height / 2, width / 2).fill({ color: PLANT_GREEN, alpha: 0.15 }).stroke({ width: 2, color: PLANT_GREEN, alpha: 0.4 });
      break;
    }
    case "desk": {
      g.roundRect(x, y, width, height, 6).fill({ color: LINE, alpha: 0.08 }).stroke({ width: 1.5, color: LINE, alpha: 0.15 });
      break;
    }
    case "table": {
      g.roundRect(x, y, width, height, Math.min(40, height / 2)).fill({ color: LINE, alpha: 0.05 }).stroke({ width: 1.5, color: LINE, alpha: 0.2 });
      break;
    }
    case "sofa": {
      g.roundRect(x, y, width, height, height / 2).fill({ color: ACCENT, alpha: 0.15 }).stroke({ width: 2, color: ACCENT, alpha: 0.3 });
      break;
    }
    case "counter": {
      g.roundRect(x, y, width, height, 6).fill({ color: LINE, alpha: 0.08 }).stroke({ width: 1.5, color: LINE, alpha: 0.15 });
      break;
    }
    case "screen": {
      g.rect(x, y, width, height).fill({ color: LINE, alpha: 0.35 });
      break;
    }
    case "stage": {
      g.roundRect(x, y, width, height, 8).fill({ color: LINE, alpha: 0.06 }).stroke({ width: 1.5, color: LINE, alpha: 0.2 });
      break;
    }
    case "whiteboard": {
      g.rect(x, y, width, height).fill({ color: LINE, alpha: 0.8 });
      break;
    }
    case "wall": {
      g.rect(x, y, width, height).fill({ color: LINE, alpha: 0.2 });
      break;
    }
    case "door": {
      g.rect(x, y, width, height).stroke({ width: 2, color: LINE, alpha: 0.4 });
      break;
    }
    default: {
      g.rect(x, y, width, height).fill({ color: LINE, alpha: 0.08 }).stroke({ width: 1.5, color: LINE, alpha: 0.15 });
    }
  }

  layer.addChild(g);
}

/**
 * One plate of the floor: its top, the furniture standing on it, and (for a whole area) its name move up together
 * when it is raised. It has a visible thickness and casts a soft shadow that stays on the floor and grows as the plate
 * rises (the Gemini map's platforms).
 */
class FloorSlab {
  readonly container = new Container();
  readonly shadow: Graphics;
  /** The area's name, when this plate has one (a group plate does not) — kept so buildFloorView can
   *  collect it for `setZoom`'s billboard scaling. */
  readonly label: Container | null;

  /** `depth` orders plates back to front, so a plate's side wall never covers one standing in front of it. */
  constructor(
    plan: SlabPlan,
    private readonly depth: number,
    zone: LayoutZone,
  ) {
    const box = plan.rect;
    const radius = plan.isGroup ? 10 : 16;
    const thickness = plan.isGroup ? GROUP_THICKNESS : AREA_THICKNESS;
    // The side wall: the same outline, pushed straight down the screen, drawn first so the top face covers most of it.
    const wall = screenStep(0, thickness);
    this.container.addChild(
      new Graphics()
        .roundRect(box.x + wall.x, box.y + wall.y, box.width, box.height, radius)
        .fill(SLAB_EDGE)
        .stroke({ width: 1.5, color: LINE, alpha: 0.08 }),
    );
    drawPanel(this.container, box, radius);
    this.label = plan.isGroup ? null : drawZoneLabel(this.container, zone, box);

    this.shadow = new Graphics();
    // Three stacked, slightly larger copies with faint fills make a soft edge without a blur filter (which is costly).
    for (const [grow, alpha] of [[14, 0.12], [8, 0.16], [2, 0.22]] as const) {
      this.shadow.roundRect(box.x - grow, box.y - grow, box.width + grow * 2, box.height + grow * 2, radius + grow).fill({ color: BLACK, alpha });
    }
    this.setLift(0);
  }

  /** Raises the plate by `height` (how much higher it appears on the screen, before zoom). */
  setLift(height: number): void {
    const step = liftVector(height);
    this.container.position.set(step.x, step.y);
    // Back to front at rest; above everything for as long as it is off the floor.
    this.container.zIndex = this.depth + (height > 0 ? 1000 : 0);
    const away = REST_SHADOW_OFFSET + height * 0.6;
    const offset = screenStep(-away, away);
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
  /** Keeps every area name at least MIN_ZONE_LABEL_PX on screen at the given zoom — it still shrinks
   *  and grows with the map above that floor, and stays tilted with the floor exactly as before
   *  (zoomFloorMatrix touches only the size, never the tilt). Call this once whenever the view's zoom
   *  changes (PixiStage does, from Viewport's onZoomChanged) — it does no drawing of its own, just
   *  resets each label's own counter-scale, so it is cheap even with many areas and never runs on a
   *  frame where the zoom did not change. */
  setZoom(zoom: number): void;
}

export function buildFloorView(layout: RoomLayout): FloorView {
  const plan = planFloor(layout);
  const container = new Container();
  const shadows = new Container();
  const slabLayer = new Container();
  slabLayer.sortableChildren = true;
  const loose = new Container(); // area names of split areas, and furniture that stands on no plate
  container.addChild(shadows, slabLayer, loose);

  // On the screen, further down means further forward: that is where y grows and x shrinks on the flat floor.
  const centreDepth = (r: Box) => r.y + r.height / 2 - (r.x + r.width / 2);
  const backToFront = [...plan.slabs].sort((a, b) => centreDepth(a.rect) - centreDepth(b.rect));
  const slabs = new Map<string, FloorSlab>();
  // Every area-name wrapper (both a whole area's own plate and a split area's loose label), for setZoom.
  const labels: Container[] = [];
  for (const slabPlan of plan.slabs) {
    const zone = layout.zones.find((z) => z.id === slabPlan.zoneId)!;
    const slab = new FloorSlab(slabPlan, backToFront.indexOf(slabPlan), zone);
    slabs.set(slabPlan.id, slab);
    shadows.addChild(slab.shadow);
    slabLayer.addChild(slab.container);
    if (slab.label) labels.push(slab.label);
    for (const i of slabPlan.pieces) drawFurniturePiece(slab.container, layout.furniture[i]);
  }
  for (const zone of layout.zones) {
    if (plan.splitZoneIds.has(zone.id)) labels.push(drawZoneLabel(loose, zone, tileRectToWorld(zone.rect)));
  }
  for (const i of plan.loosePieces) drawFurniturePiece(loose, layout.furniture[i]);

  return {
    container,
    plan,
    setLift(slabId, height) {
      slabs.get(slabId)?.setLift(height);
    },
    setZoom(zoom) {
      const m = zoomFloorMatrix(zoom, ZONE_LABEL_FLOOR_AT);
      const matrix = new Matrix(m.a, m.b, m.c, m.d, 0, 0);
      for (const label of labels) label.setFromMatrix(matrix);
    },
  };
}
