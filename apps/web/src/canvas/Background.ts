import { Container, Graphics } from "pixi.js";

const GRID_SPACING = 100;
const GRID_COLOR = 0x1c2130;
const BOUNDS_COLOR = 0x3a4266;
const BACKGROUND_COLOR = 0x11141c;

/**
 * A visible world grid + bounds border, sized to the room's own floor
 * bounds (see @workspace-video/shared's movementConfigForLayout) so what's drawn
 * always matches where an avatar can actually go — never the global
 * DEFAULT_MOVEMENT_CONFIG, which would draw the wrong-sized floor for any
 * layout other than the 8000x8000 default. Built once as static Graphics —
 * this layer never changes per frame, unlike avatars.
 */
export function createBackground(bounds: { roomWidthPx: number; roomHeightPx: number }): Container {
  const container = new Container();
  const { roomWidthPx, roomHeightPx } = bounds;

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
