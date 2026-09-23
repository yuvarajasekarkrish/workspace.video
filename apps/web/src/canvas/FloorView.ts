import { Container, Graphics, Sprite, Texture } from "pixi.js";
import type { RoomLayout, FurniturePiece } from "@workspace-video/shared";
import { liftVector, screenStep } from "./lift";
import { planFloor, type Box, type FloorPlan, type SlabPlan } from "./slabPlan";
import { ACCENT, BLACK, CHAIR_FILL, LINE, PANEL_FILL, PLANT_GREEN, SLAB_EDGE } from "./palette";

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

// The approved chair photo, shared by every chair drawn anywhere in the app - loaded once, not
// once per chair or once per room. Uses a plain <img> + Texture.from(img) rather than
// Assets.load(url): proven on the "ChairCoded" artifact board, where Assets.load(url) silently
// failed on an extension-less URL. This file's real URL does have an extension, but the load
// path stays identical to what was already tested working, per the owner's instruction.
let chairTexturePromise: Promise<Texture> | null = null;
function getChairTexture(): Promise<Texture> {
  if (!chairTexturePromise) {
    chairTexturePromise = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(Texture.from(img));
      img.onerror = () => reject(new Error("chair texture failed to load: /furniture/chair.png"));
      img.src = "/furniture/chair.png";
    });
  }
  return chairTexturePromise;
}

// The chair's clickable seat radius (queries.ts's hitTestSeats, 28px around the seat anchor) and
// every desk/table spacing formula (modules.ts) are keyed off CHAIR_SIZE (32px) and are NOT
// touched here - only how big the picture itself is drawn. At the room's typical "fit whole
// floor" zoom a 32px chair renders only a few screen pixels, effectively invisible. 1.3x is as
// far as this can go without the chair visually overlapping its own desk: every spacing formula
// leaves exactly 6px of clearance beyond the assumed 16px chair half-width (see modules.ts's
// "+ 6"), and 1.3x keeps the enlarged half-width (~20.8px) inside that same clearance.
const CHAIR_VISUAL_SCALE = 1.3;

// Swaps the plain circle placeholder for the real chair image once the shared texture is ready.
// The circle is already drawn and on screen by the time this resolves, so nothing is ever missing
// while the image loads. If the load fails, the placeholder simply stays - same "never show
// nothing" behavior as ObjectView.ts's image loading.
function queueChairSprite(layer: Container, placeholder: Graphics, piece: FurniturePiece): void {
  const { x, y, width, height, rotation } = piece;
  getChairTexture()
    .then((texture) => {
      if (layer.destroyed || placeholder.destroyed) return; // room rebuilt or torn down mid-load
      // The photo's own average colour measures 1.53:1 / 1.82:1 against the panel/ground - a
      // photo's own pixels can't be recoloured like a fill, so a backing plate in the same
      // WCAG-passing CHAIR_FILL grey sits behind it, giving the chair a boundary that clears
      // 3:1 whether or not the photo itself does at any given point in the image.
      const backing = new Graphics()
        .circle(0, 0, (width / 2) * CHAIR_VISUAL_SCALE)
        .fill(CHAIR_FILL);
      backing.position.set(x + width / 2, y + height / 2);
      const sprite = new Sprite(texture);
      sprite.anchor.set(0.5);
      sprite.width = width * CHAIR_VISUAL_SCALE;
      sprite.height = height * CHAIR_VISUAL_SCALE;
      sprite.rotation = rotation;
      sprite.position.set(x + width / 2, y + height / 2);
      layer.addChild(backing);
      layer.addChild(sprite);
      layer.removeChild(placeholder);
    })
    .catch(() => {
      // Placeholder circle stays visible - never a blank spot where a chair should be.
    });
}

function drawPanel(layer: Container, box: Box, radius: number): void {
  layer.addChild(
    new Graphics()
      .roundRect(box.x, box.y, box.width, box.height, radius)
      .fill({ color: PANEL_FILL, alpha: PANEL_FILL_ALPHA })
      .stroke({ width: 2, color: LINE, alpha: 0.1 }),
  );
}

function drawFurniturePiece(layer: Container, piece: FurniturePiece): void {
  const { x, y, width, height } = piece;
  const g = new Graphics();

  switch (piece.kind) {
    case "chair": {
      // Same visual-only enlargement as the sprite it's a placeholder for (queueChairSprite) -
      // width/height stay CHAIR_SIZE for hit-testing and spacing, only the drawn radius grows.
      g.circle(x + width / 2, y + height / 2, (width / 2) * CHAIR_VISUAL_SCALE)
        .fill(CHAIR_FILL)
        .stroke({ width: 1.5, color: LINE, alpha: 0.15 });
      break;
    }
    case "plant": {
      g.circle(x + width / 2, y + height / 2, width / 2).fill({ color: PLANT_GREEN, alpha: 0.15 }).stroke({ width: 2, color: PLANT_GREEN, alpha: 0.4 });
      break;
    }
    case "desk": {
      // alpha was 0.08 (1.26:1 against the panel, measured) - fails WCAG 1.4.11's 3:1 non-text
      // minimum. 0.34 is the lowest alpha of this same white-on-graphite fill that clears it
      // (3.13:1, measured) - same colours, no new hue, just enough of it to be seen.
      g.roundRect(x, y, width, height, 6).fill({ color: LINE, alpha: 0.34 }).stroke({ width: 1.5, color: LINE, alpha: 0.15 });
      break;
    }
    case "table": {
      // Same measured fix as "desk": 0.05 was 1.15:1, 0.34 clears WCAG's 3:1 minimum.
      g.roundRect(x, y, width, height, Math.min(40, height / 2)).fill({ color: LINE, alpha: 0.34 }).stroke({ width: 1.5, color: LINE, alpha: 0.2 });
      break;
    }
    case "sofa": {
      g.roundRect(x, y, width, height, height / 2).fill({ color: ACCENT, alpha: 0.15 }).stroke({ width: 2, color: ACCENT, alpha: 0.3 });
      break;
    }
    case "counter": {
      // Same fill formula, same fix as "desk" above.
      g.roundRect(x, y, width, height, 6).fill({ color: LINE, alpha: 0.34 }).stroke({ width: 1.5, color: LINE, alpha: 0.15 });
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
  if (piece.kind === "chair") queueChairSprite(layer, g, piece);
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
}

export function buildFloorView(layout: RoomLayout): FloorView {
  const plan = planFloor(layout);
  const container = new Container();
  const shadows = new Container();
  const slabLayer = new Container();
  slabLayer.sortableChildren = true;
  const loose = new Container(); // furniture that stands on no plate
  container.addChild(shadows, slabLayer, loose);

  // On the screen, further down means further forward: that is where y grows and x shrinks on the flat floor.
  const centreDepth = (r: Box) => r.y + r.height / 2 - (r.x + r.width / 2);
  const backToFront = [...plan.slabs].sort((a, b) => centreDepth(a.rect) - centreDepth(b.rect));
  const slabs = new Map<string, FloorSlab>();
  for (const slabPlan of plan.slabs) {
    const slab = new FloorSlab(slabPlan, backToFront.indexOf(slabPlan));
    slabs.set(slabPlan.id, slab);
    shadows.addChild(slab.shadow);
    slabLayer.addChild(slab.container);
    for (const i of slabPlan.pieces) drawFurniturePiece(slab.container, layout.furniture[i]);
  }
  for (const i of plan.loosePieces) drawFurniturePiece(loose, layout.furniture[i]);

  return {
    container,
    plan,
    setLift(slabId, height) {
      slabs.get(slabId)?.setLift(height);
    },
  };
}
