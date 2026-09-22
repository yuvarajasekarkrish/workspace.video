/**
 * A workspace's own look: one accent colour from a fixed set of six palettes, and whether its room
 * is drawn flat (looking straight down) or tilted (today's look). Both are per-workspace settings an
 * owner or admin saves, the same way a role is changed (packages/db/src/roomLayouts.ts,
 * changeMemberRole). See docs/architecture/company-map-builder.md, D18-D20.
 *
 * This file has no database and no screens, so the palette values and the readability rule can be
 * read and tested on their own, the same as packages/shared/src/permissions.ts.
 */

import type { WorkspaceRoleName } from "./permissions";

export const WORKSPACE_ACCENT_PALETTES = [
  {
    id: "coral",
    label: "Sunset Coral & Rose",
    accent: "#f43f5e",
    accentHover: "#e11d48",
    glow: "rgba(244, 63, 94, 0.35)",
    monitorGlow: "#fda4af",
  },
  {
    id: "cyan",
    label: "Electric Cyan",
    accent: "#0ea5e9",
    accentHover: "#0284c7",
    glow: "rgba(14, 165, 233, 0.35)",
    monitorGlow: "#7dd3fc",
  },
  {
    id: "emerald",
    label: "Emerald & Teal",
    accent: "#10b981",
    accentHover: "#059669",
    glow: "rgba(16, 185, 129, 0.35)",
    monitorGlow: "#6ee7b7",
  },
  {
    // Lightened from the owner's #6366f1 (4.43:1, just under the 4.5:1 limit) to #6d70f2 (4.95:1),
    // an owner decision recorded in D18. The hover shade stays the owner's original #4f46e5.
    id: "indigo",
    label: "Electric Indigo",
    accent: "#6d70f2",
    accentHover: "#4f46e5",
    glow: "rgba(99, 102, 241, 0.35)",
    monitorGlow: "#c7d2fe",
  },
  {
    id: "amethyst",
    label: "Twilight Amethyst",
    accent: "#8b5cf6",
    accentHover: "#7c3aed",
    glow: "rgba(139, 92, 246, 0.35)",
    monitorGlow: "#c4b5fd",
  },
  {
    id: "lime",
    label: "Cyber Lime",
    accent: "#22c55e",
    accentHover: "#16a34a",
    glow: "rgba(34, 197, 94, 0.35)",
    monitorGlow: "#86efac",
  },
] as const;

export type WorkspaceAccentPaletteId = (typeof WORKSPACE_ACCENT_PALETTES)[number]["id"];

const PALETTE_IDS = WORKSPACE_ACCENT_PALETTES.map((p) => p.id) as readonly string[];

export function isWorkspaceAccentPaletteId(value: unknown): value is WorkspaceAccentPaletteId {
  return typeof value === "string" && PALETTE_IDS.includes(value);
}

export function paletteById(id: WorkspaceAccentPaletteId) {
  // Never undefined: id's type is drawn from the same list, and the list is never edited at runtime.
  return WORKSPACE_ACCENT_PALETTES.find((p) => p.id === id)!;
}

export const WORKSPACE_VIEW_MODES = ["flat", "tilted"] as const;
export type WorkspaceViewMode = (typeof WORKSPACE_VIEW_MODES)[number];

export function isWorkspaceViewMode(value: unknown): value is WorkspaceViewMode {
  return typeof value === "string" && (WORKSPACE_VIEW_MODES as readonly string[]).includes(value);
}

/** Only an owner or admin may change how the whole workspace looks (D19). A designer may change the
 *  map's layout (canDoLayoutAction) but not its colour or its flat/tilted setting — those are not
 *  the map, they are the workspace's own look. */
export function canChangeWorkspaceAppearance(role: WorkspaceRoleName | null): boolean {
  return role === "owner" || role === "admin";
}

// --- Readability -------------------------------------------------------------------------------
// WCAG relative luminance and contrast ratio, the same formula DESIGN.md's own tests use
// (apps/web/src/app/globals.css's designTokens.test.ts). Kept here, not imported from the web app,
// so this package has no dependency on it; the two are tested against each other in
// __tests__/workspaceAppearance.test.ts by asserting both compute the same numbers.
function channel(hex: string, index: 1 | 3 | 5): number {
  const v = parseInt(hex.slice(index, index + 2), 16) / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(hex: string): number {
  return 0.2126 * channel(hex, 1) + 0.7152 * channel(hex, 3) + 0.0722 * channel(hex, 5);
}

/** WCAG contrast ratio between two solid hex colours (no alpha), 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [l1, l2] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** The ground colour dark text sits on (DESIGN.md's --color-ground, apps/web/src/app/globals.css). */
export const GROUND_HEX = "#0a0a0a";

/** DESIGN.md's own text-contrast floor (designTokens.test.ts): 4.5:1 for body text. */
export const MIN_TEXT_CONTRAST = 4.5;
