import { Container, Graphics } from "pixi.js";
import { DEFAULT_MOVEMENT_CONFIG } from "@cosmos/shared";

const GRID_SPACING = 100;
const GRID_COLOR = 0x1c2130;
const BOUNDS_COLOR = 0x3a4266;
const BACKGROUND_COLOR = 0x11141c;

/**
 * A visible world grid + bounds border, sized to the same room bounds the
 * server enforces (DEFAULT_MOVEMENT_CONFIG) so what's drawn always matches
 * where an avatar can actually go. Built once as static Graphics — this
 * layer never changes per frame, unlike avatars.
 */
export function createBackground(): Container {
  const container = new Container();
  const { roomWidthPx, roomHeightPx } = DEFAULT_MOVEMENT_CONFIG;

  const fill = new Graphics().rect(0, 0, roomWidthPx, roomHeightPx).fill(BACKGROUND_COLOR);
  container.addChild(fill);

  const grid = new Graphics();
  for (let x = 0; x <= roomWidthPx; x += GRID_SPACING) {
    grid.moveTo(x, 0).lineTo(x, roomHeightPx);
  }
  for (let y = 0; y <= roomHeightPx; y += GRID_SPACING) {
    grid.moveTo(0, y).lineTo(roomWidthPx, y);
  }
  grid.stroke({ width: 1, color: GRID_COLOR });
  container.addChild(grid);

  const border = new Graphics()
    .rect(0, 0, roomWidthPx, roomHeightPx)
    .stroke({ width: 4, color: BOUNDS_COLOR });
  container.addChild(border);

  return container;
}
