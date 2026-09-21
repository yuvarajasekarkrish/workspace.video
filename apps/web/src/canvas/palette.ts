/**
 * Every colour the room canvas draws with, in one place. Before this the same amber was copied into four files, so
 * changing the accent (or moving the room onto DESIGN.md's colours) meant hunting for copies and missing one. A colour
 * written anywhere else in the canvas code fails palette.test.ts.
 *
 * Numbers (0xRRGGBB) because that is what Pixi draws with; `cssHex` gives the text form for the few places that need it.
 */

/** 0xf5a623 -> "#f5a623". */
export function cssHex(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

// The basics.
export const GROUND = 0x0a0a0a;
export const GROUND_CSS = cssHex(GROUND);
export const WHITE = 0xffffff;
export const BLACK = 0x000000;
/** Dark ink: the outline of another person's dot and the text on a note. */
export const INK = 0x1a1a1a;
/** The one accent: your own dot, a selected object, an occupied seat and the sofas. */
export const ACCENT = 0xf5a623;

// People.
export const PERSON_SLATE = 0x64748b;
export const NAME_TAG_TEXT = 0xe2e8f0;

// The floor and its furniture.
export const LINE = WHITE;
export const PANEL_FILL = 0x1e1e1e;
export const SLAB_EDGE = 0x121212;
export const CHAIR_FILL = 0x334155;
export const PLANT_GREEN = 0x10b981;

// Things people add to the map.
export const NOTE_FILL: Record<string, number> = {
  yellow: 0xfff3a0,
  pink: 0xffc9de,
  blue: 0xaee1ff,
  green: 0xc4f2c2,
  purple: 0xdcc9ff,
};
export const LINK_STROKE = 0xd0d4dc;
export const SHAPE_FILL = 0x4f8cff;
export const ZONE_COLOR = 0x50c878;
export const IMAGE_PLACEHOLDER_FILL = 0x1c2130;
export const IMAGE_PLACEHOLDER_STROKE = 0x3a4266;
export const EMBED_FILL = 0x2a2f3d;
export const EMBED_STROKE = 0x4a5066;
export const EMBED_TEXT = 0x8890a0;
