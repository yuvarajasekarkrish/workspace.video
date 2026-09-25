import { Container, Graphics } from "pixi.js";
import { TILE_PX } from "@workspace-video/shared";
import { LINE } from "./palette";

/**
 * A faint reference grid drawn on the floor, one line per real tile (TILE_PX = 160px - the exact
 * same unit every layout's TileRect already uses, see grid.ts in @workspace-video/shared). Purely
 * visual: built once from the floor's own cols/rows, drawn on top of the concrete floor and
 * beneath every plate/furniture layer, and never touched again by the render loop - same "built
 * once" rule the rest of FloorView.ts follows.
 *
 * Reads the layout's real floor size and TILE_PX only - it does not read, depend on, or alter
 * any layout file (openOffice.ts, office300.ts, modules.ts). Removing this file and its one call
 * site in FloorView.ts fully removes the grid with zero effect on any layout or on furniture
 * rendering.
 */
export function buildGridOverlay(floorCols: number, floorRows: number): Container {
  const container = new Container();
  const g = new Graphics();
  const width = floorCols * TILE_PX;
  const height = floorRows * TILE_PX;

  for (let col = 0; col <= floorCols; col++) {
    const x = col * TILE_PX;
    g.moveTo(x, 0).lineTo(x, height);
  }
  for (let row = 0; row <= floorRows; row++) {
    const y = row * TILE_PX;
    g.moveTo(0, y).lineTo(width, y);
  }
  // Faint enough to read as a reference grid, not compete with furniture - same LINE colour
  // (white) already used for every other outline in this file, just a very low alpha.
  g.stroke({ width: 1, color: LINE, alpha: 0.06 });

  container.addChild(g);
  return container;
}
