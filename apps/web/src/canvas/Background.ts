import { Container, Graphics } from "pixi.js";
import { GROUND, WHITE } from "./palette";

// The Gemini design's floor: charcoal, with a faint dot grid instead of lines (docs/designs/gemini-landing.html.html).
const DOT_SPACING = 80;
const DOT_RADIUS = 1.6;
const DOT_ALPHA = 0.1;
const BOUNDS_ALPHA = 0.12;

/**
 * The floor: charcoal ground, a faint dot grid and a soft border, sized to the room's own floor
 * bounds (see @workspace-video/shared's movementConfigForLayout) so what's drawn
 * always matches where an avatar can actually go — never the global
 * DEFAULT_MOVEMENT_CONFIG, which would draw the wrong-sized floor for any
 * layout other than the 8000x8000 default. Built once as static Graphics —
 * this layer never changes per frame, unlike avatars.
 */
export function createBackground(bounds: { roomWidthPx: number; roomHeightPx: number }): Container {
  const container = new Container();
  const { roomWidthPx, roomHeightPx } = bounds;

  const fill = new Graphics().rect(0, 0, roomWidthPx, roomHeightPx).fill(GROUND);
  container.addChild(fill);

  const dots = new Graphics();
  for (let x = DOT_SPACING / 2; x < roomWidthPx; x += DOT_SPACING) {
    for (let y = DOT_SPACING / 2; y < roomHeightPx; y += DOT_SPACING) {
      dots.circle(x, y, DOT_RADIUS);
    }
  }
  dots.fill({ color: WHITE, alpha: DOT_ALPHA });
  container.addChild(dots);

  const border = new Graphics().rect(0, 0, roomWidthPx, roomHeightPx).stroke({ width: 3, color: WHITE, alpha: BOUNDS_ALPHA });
  container.addChild(border);

  return container;
}
