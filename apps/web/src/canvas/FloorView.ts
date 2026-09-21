import { Container, Graphics, Text } from "pixi.js";
import type { RoomLayout, FurniturePiece, LayoutZone } from "@workspace-video/shared";
import { tileRectToWorld, zoneAt } from "@workspace-video/shared";
import { liftVector, screenStep } from "./lift";

/**
 * The office floor: a layout's areas and furniture, drawn once in the Gemini design's look (charcoal panels, soft
 * white outlines, one amber accent; docs/designs/gemini-landing.html.html). Built ONCE from the layout and never
 * touched by the per-frame render loop; this is the whole point of keeping furniture out of objectsStore (see the
 * Phase 8 plan's rendering section). Seat occupancy (who's sitting where) is a separate, small overlay added on top
 * (SeatOverlay.ts): this module only draws the room as it exists at rest.
 */

const AMBER = 0xf5a623;
const GREEN = 0x10b981;
const CHAIR_FILL = 0x334155;
const PANEL_FILL = 0x1e1e1e;
// Nearly solid, so the shadow under a raised area does not show through it.
const PANEL_FILL_ALPHA = 0.92;
// How far the shadow sits down and to the left of an area at rest, on the screen. Raising the area pushes it further.
const REST_SHADOW_OFFSET = 6;
// How thick a slab looks, in screen pixels before zoom: the strip of side wall seen below its top face.
const SLAB_THICKNESS = 14;
const EDGE_FILL = 0x121212;
const LINE = 0xffffff;

function drawZone(layer: Container, zone: LayoutZone): void {
  const box = tileRectToWorld(zone.rect);
  const panel = new Graphics()
    .roundRect(box.x, box.y, box.width, box.height, 16)
    .fill({ color: PANEL_FILL, alpha: PANEL_FILL_ALPHA })
    .stroke({ width: 2, color: LINE, alpha: 0.1 });
  layer.addChild(panel);

  // The area's name lies quietly in its bottom-right corner, as on the Gemini map.
  const label = new Text({
    text: zone.label,
    style: {
      fill: 0xffffff,
      fontSize: 15,
      letterSpacing: 2,
      fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif",
      fontWeight: "300",
    },
  });
  label.alpha = 0.6;
  label.anchor.set(1, 1);
  label.position.set(box.x + box.width - 22, box.y + box.height - 16);
  layer.addChild(label);
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
      g.circle(x + width / 2, y + height / 2, width / 2).fill({ color: GREEN, alpha: 0.15 }).stroke({ width: 2, color: GREEN, alpha: 0.4 });
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
      g.roundRect(x, y, width, height, height / 2).fill({ color: AMBER, alpha: 0.15 }).stroke({ width: 2, color: AMBER, alpha: 0.3 });
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
 * One area of the floor as a slab: its panel, its name and the furniture standing on it move up together when it is
 * raised, and it casts a soft shadow that stays on the floor and grows as the slab rises (the Gemini map's platforms).
 */
class FloorSlab {
  readonly container = new Container();
  readonly shadow: Graphics;

  /** `depth` orders slabs back to front, so a slab's side wall never covers one standing in front of it. */
  constructor(zone: LayoutZone, private readonly depth: number) {
    const box = tileRectToWorld(zone.rect);
    // The side wall: the same outline, pushed straight down the screen, drawn first so the top face covers most of it.
    const wall = screenStep(0, SLAB_THICKNESS);
    this.container.addChild(
      new Graphics()
        .roundRect(box.x + wall.x, box.y + wall.y, box.width, box.height, 16)
        .fill(EDGE_FILL)
        .stroke({ width: 1.5, color: LINE, alpha: 0.08 }),
    );
    drawZone(this.container, zone);
    this.shadow = new Graphics();
    // Three stacked, slightly larger copies with faint fills make a soft edge without a blur filter (which is costly).
    for (const [grow, alpha] of [[14, 0.12], [8, 0.16], [2, 0.22]] as const) {
      this.shadow.roundRect(box.x - grow, box.y - grow, box.width + grow * 2, box.height + grow * 2, 16 + grow).fill({ color: 0x000000, alpha });
    }
    this.setLift(0);
  }

  /** Raises the slab by `height` (how much higher it appears on the screen, before zoom). */
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
  /** Raises one area by that much (0 puts it back on the floor). Areas that do not exist are ignored. */
  setLift(zoneId: string, height: number): void;
}

export function buildFloorView(layout: RoomLayout): FloorView {
  const container = new Container();
  const shadows = new Container();
  const slabLayer = new Container();
  slabLayer.sortableChildren = true;
  const loose = new Container(); // furniture that stands outside every area
  container.addChild(shadows, slabLayer, loose);

  // Areas draw first (bottom), so furniture always sits visibly on top of an area's panel and its name.
  const slabs = new Map<string, FloorSlab>();
  // On the screen, further down means further forward: that is where y grows and x shrinks on the flat floor.
  const centreDepth = (z: LayoutZone) => tileRectToWorld(z.rect).y + tileRectToWorld(z.rect).height / 2 - (tileRectToWorld(z.rect).x + tileRectToWorld(z.rect).width / 2);
  const backToFront = [...layout.zones].sort((a, b) => centreDepth(a) - centreDepth(b));
  for (const zone of layout.zones) {
    const slab = new FloorSlab(zone, backToFront.indexOf(zone));
    slabs.set(zone.id, slab);
    shadows.addChild(slab.shadow);
    slabLayer.addChild(slab.container);
  }
  // Each piece of furniture goes with the area its middle is in, so it rises with it.
  for (const piece of layout.furniture) {
    const owner = zoneAt(layout, { x: piece.x + piece.width / 2, y: piece.y + piece.height / 2 });
    drawFurniturePiece(owner ? (slabs.get(owner.id)?.container ?? loose) : loose, piece);
  }

  return {
    container,
    setLift(zoneId, height) {
      slabs.get(zoneId)?.setLift(height);
    },
  };
}
