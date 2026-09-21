import { Container, Graphics, Text } from "pixi.js";
import type { RoomLayout, FurniturePiece, LayoutZone } from "@workspace-video/shared";
import { tileRectToWorld } from "@workspace-video/shared";

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
const PANEL_FILL_ALPHA = 0.7;
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

export function buildFloorView(layout: RoomLayout): Container {
  const layer = new Container();

  // Areas draw first (bottom), so furniture always sits visibly on top of an area's panel and its name.
  for (const zone of layout.zones) {
    drawZone(layer, zone);
  }
  for (const piece of layout.furniture) {
    drawFurniturePiece(layer, piece);
  }

  return layer;
}
