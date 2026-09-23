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
// Was 0x334155 (1.61:1 on the panel, 1.91:1 on ground - both fail WCAG 1.4.11's 3:1 minimum for
// non-text contrast, measured directly). 0x696969 is the darkest pure grey - still black/graphite/
// white, no new hue - that clears 3:1 against both backgrounds (3.04:1 / 3.61:1, measured).
export const CHAIR_FILL = 0x696969;
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

// The rendered-office look (the owner's reference image, 2026-09-23): one grey concrete floor and
// monochrome furniture with real height, shaded by which face is seen.
export const CONCRETE = 0x2a2a2d;
export const CONCRETE_EDGE = 0x1b1b1d;
export const FURNITURE_DARK = 0x2c2c2f;
export const FURNITURE_MID = 0x4e4e53;
export const FURNITURE_LIGHT = 0x9a9a9f;
export const TABLE_TOP = 0x77777c;
export const MONITOR = 0x151517;
export const FOLIAGE = 0x56634f;
export const PARTITION = 0x2a2a2d;
export const GLASS = 0xa9bccb;
export const WOOD = 0x6b5a48;
/** The ring over a free seat in the area under the mouse. */
export const FREE_SEAT = 0x4ade80;
/** The faint blue glow on a monitor's screen. */
export const SCREEN_GLOW = 0x3a4a5a;
/** Small warm touches in the rendered office: fruit, a marker, stage lights and the whiteboard. */
export const FRUIT_YELLOW = 0xc9a44a;
export const FRUIT_RED = 0xb5563f;
export const FRUIT_GREEN = 0x7c9a4a;
export const WHITEBOARD = 0xe8e8ea;
/**
 * Chairs must be easy to see at the fitted zoom, without zooming in: WCAG 2.2 non-text contrast (1.4.11) asks for
 * at least 3:1 against what is next to them. Seat on floor 11.3:1, back on floor 8.2:1, seat on a table 3.5:1, table on
 * floor 3.2:1 (checked with the WCAG relative-luminance formula, 2026-09-23).
 */
export const CHAIR_SEAT = 0xe4e4e8;
export const CHAIR_BACK = 0xc4c4ca;

/**
 * The product theme in the room (the owner's call, 2026-09-23, following the landing page): strict monochrome —
 * black, graphite, white — with no accent colour. State is shown by fill, outline, dashes and glow instead of hue,
 * each pair checked against WCAG 2.2 non-text contrast (1.4.11, at least 3:1):
 *   you (white) on floor 14.3 · another person (grey) on floor 5.1 · a person's dark outline on a chair 15.6
 *   taken seat (black dot) on a chair 15.6, its white rim on the floor 14.3 · free-seat dashed ring on floor 14.3,
 *   on a table 4.5 · floor border on the page 3.9.
 */
export const ROOM_SELF = WHITE;
export const ROOM_PERSON = 0x9a9aa0;
export const ROOM_OUTLINE = 0x0a0a0a;
export const ROOM_TAKEN = 0x0a0a0a;
export const ROOM_FREE_RING = WHITE;
export const ROOM_SELECTION = WHITE;
export const FLOOR_BORDER = 0x6e6e73;
