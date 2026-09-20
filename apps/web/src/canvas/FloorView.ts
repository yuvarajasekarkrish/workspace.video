import { Container, Graphics, Text } from "pixi.js";
import type { RoomLayout, FurniturePiece, LayoutZone } from "@workspace-video/shared";
import { tileRectToWorld } from "@workspace-video/shared";

/**
 * Static line-art rendering of a RoomLayout's furniture and zone
 * boundaries — "the office floor" the design canvas mocked up. Built ONCE
 * from the layout and never touched by the per-frame render loop; this is
 * the whole point of keeping furniture out of objectsStore (see the Phase 8
 * plan's rendering section). Seat occupancy (who's sitting where) is a
 * separate, small overlay added on top in a later step — this module only
 * draws the room as it exists at rest.
 */

const INK = 0x8c95a3;
const FLOOR_LIGHT = 0xffffff;
const LOUNGE_TINT = 0xeef1f5;
const PLANT_FILL = 0xe6f2e9;
const PLANT_STROKE = 0x86b896;
const ZONE_LABEL_BG = 0x1c212a;
const ZONE_LABEL_TEXT = 0xeef1f5;
const ZONE_BORDER = 0xc3c9d2;

function drawDashedRect(g: Graphics, x: number, y: number, width: number, height: number, dash = 8, gap = 6): void {
  const segments: [number, number, number, number][] = [
    [x, y, x + width, y],
    [x + width, y, x + width, y + height],
    [x + width, y + height, x, y + height],
    [x, y + height, x, y],
  ];
  for (const [x1, y1, x2, y2] of segments) {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const steps = Math.max(1, Math.floor(length / (dash + gap)));
    const dx = (x2 - x1) / length;
    const dy = (y2 - y1) / length;
    let travelled = 0;
    for (let i = 0; i < steps && travelled < length; i++) {
      const start = travelled;
      const end = Math.min(length, travelled + dash);
      g.moveTo(x1 + dx * start, y1 + dy * start).lineTo(x1 + dx * end, y1 + dy * end);
      travelled += dash + gap;
    }
  }
}

function drawZone(layer: Container, zone: LayoutZone): void {
  const box = tileRectToWorld(zone.rect);
  const g = new Graphics();
  drawDashedRect(g, box.x, box.y, box.width, box.height);
  g.stroke({ width: 1.5, color: ZONE_BORDER });
  layer.addChild(g);

  const label = new Text({
    text: zone.label,
    style: { fill: ZONE_LABEL_TEXT, fontSize: 11, fontFamily: "ui-sans-serif, system-ui, sans-serif", fontWeight: "500" },
  });
  const pillPad = 6;
  const pill = new Graphics()
    .roundRect(0, 0, label.width + pillPad * 2, label.height + pillPad, 4)
    .fill({ color: ZONE_LABEL_BG, alpha: 0.9 });
  const pillContainer = new Container();
  pillContainer.addChild(pill);
  label.position.set(pillPad, pillPad / 2);
  pillContainer.addChild(label);
  pillContainer.position.set(box.x + 8, box.y + 8);
  layer.addChild(pillContainer);
}

function drawFurniturePiece(layer: Container, piece: FurniturePiece): void {
  const { x, y, width, height } = piece;
  const g = new Graphics();

  switch (piece.kind) {
    case "chair": {
      g.circle(x + width / 2, y + height / 2, width / 2).fill(FLOOR_LIGHT).stroke({ width: 1.5, color: INK });
      break;
    }
    case "plant": {
      g.circle(x + width / 2, y + height / 2, width / 2).fill(PLANT_FILL).stroke({ width: 1.5, color: PLANT_STROKE });
      break;
    }
    case "desk":
    case "table": {
      g.roundRect(x, y, width, height, 3).fill(FLOOR_LIGHT).stroke({ width: 1.5, color: INK });
      break;
    }
    case "sofa": {
      g.roundRect(x, y, width, height, height / 2).fill(FLOOR_LIGHT).stroke({ width: 1.5, color: INK });
      break;
    }
    case "counter": {
      g.roundRect(x, y, width, height, 4).fill(LOUNGE_TINT).stroke({ width: 1.5, color: INK });
      break;
    }
    case "screen": {
      g.rect(x, y, width, height).fill(0xdde2e8).stroke({ width: 1, color: 0xc9cfd8 });
      break;
    }
    case "stage": {
      g.roundRect(x, y, width, height, 4).fill(0xeef1f5).stroke({ width: 1.5, color: INK });
      break;
    }
    case "whiteboard": {
      g.rect(x, y, width, height).fill(0xdde2e8).stroke({ width: 1, color: 0xc9cfd8 });
      break;
    }
    case "wall": {
      g.rect(x, y, width, height).fill(INK);
      break;
    }
    case "door": {
      g.rect(x, y, width, height).stroke({ width: 2, color: INK });
      break;
    }
    default: {
      g.rect(x, y, width, height).fill(FLOOR_LIGHT).stroke({ width: 1.5, color: INK });
    }
  }

  layer.addChild(g);
}

export function buildFloorView(layout: RoomLayout): Container {
  const layer = new Container();

  // Zones draw first (bottom), so furniture always sits visibly on top of
  // a zone's dashed boundary and label pill, matching the approved design.
  for (const zone of layout.zones) {
    drawZone(layer, zone);
  }
  for (const piece of layout.furniture) {
    drawFurniturePiece(layer, piece);
  }

  return layer;
}
