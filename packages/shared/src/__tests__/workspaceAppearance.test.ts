import { describe, it, expect } from "vitest";
import {
  WORKSPACE_ACCENT_PALETTES,
  WORKSPACE_VIEW_MODES,
  isWorkspaceAccentPaletteId,
  isWorkspaceViewMode,
  paletteById,
  canChangeWorkspaceAppearance,
  contrastRatio,
  GROUND_HEX,
  MIN_TEXT_CONTRAST,
} from "../workspaceAppearance";

// D19's approved code quality decision (2B) locks the six names in at the database as an enum; this
// file locks in the *values* so a bad hex can never quietly ship. See D18's readability table.
describe("workspace accent palettes", () => {
  it("has exactly the owner's six palettes, each with every field", () => {
    expect(WORKSPACE_ACCENT_PALETTES).toHaveLength(6);
    for (const p of WORKSPACE_ACCENT_PALETTES) {
      expect(p.id).toBeTruthy();
      expect(p.label).toBeTruthy();
      expect(p.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.accentHover).toMatch(/^#[0-9a-f]{6}$/);
      expect(p.glow).toMatch(/^rgba\(/);
      expect(p.monitorGlow).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("every palette's accent reaches the 4.5:1 text-contrast floor against the ground, with dark text (D18/D19)", () => {
    for (const p of WORKSPACE_ACCENT_PALETTES) {
      expect(contrastRatio(p.accent, GROUND_HEX)).toBeGreaterThanOrEqual(MIN_TEXT_CONTRAST);
    }
  });

  it("indigo uses the owner's lightened #6d70f2, not the original #6366f1 that missed the floor (D18, decided 2026-09-22)", () => {
    const indigo = paletteById("indigo");
    expect(indigo.accent).toBe("#6d70f2");
    expect(contrastRatio(indigo.accent, GROUND_HEX)).toBeCloseTo(4.95, 1);
  });

  it("isWorkspaceAccentPaletteId accepts only the six known ids", () => {
    for (const p of WORKSPACE_ACCENT_PALETTES) expect(isWorkspaceAccentPaletteId(p.id)).toBe(true);
    expect(isWorkspaceAccentPaletteId("purple")).toBe(false);
    expect(isWorkspaceAccentPaletteId("")).toBe(false);
    expect(isWorkspaceAccentPaletteId(undefined)).toBe(false);
  });

  it("paletteById returns the matching palette for every id", () => {
    for (const p of WORKSPACE_ACCENT_PALETTES) expect(paletteById(p.id).accent).toBe(p.accent);
  });
});

describe("workspace view mode (flat or tilted, D20)", () => {
  it("has exactly flat and tilted", () => {
    expect(WORKSPACE_VIEW_MODES).toEqual(["flat", "tilted"]);
  });

  it("isWorkspaceViewMode accepts only those two", () => {
    expect(isWorkspaceViewMode("flat")).toBe(true);
    expect(isWorkspaceViewMode("tilted")).toBe(true);
    expect(isWorkspaceViewMode("sideways")).toBe(false);
    expect(isWorkspaceViewMode(null)).toBe(false);
  });
});

describe("canChangeWorkspaceAppearance (D19: owner/admin only, not designer)", () => {
  it("allows owner and admin", () => {
    expect(canChangeWorkspaceAppearance("owner")).toBe(true);
    expect(canChangeWorkspaceAppearance("admin")).toBe(true);
  });

  it("refuses designer and member (they may edit the map, not the workspace's look) and non-members", () => {
    expect(canChangeWorkspaceAppearance("designer")).toBe(false);
    expect(canChangeWorkspaceAppearance("member")).toBe(false);
    expect(canChangeWorkspaceAppearance(null)).toBe(false);
  });
});

describe("contrastRatio", () => {
  it("is symmetric and 1:1 for identical colours", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBe(contrastRatio("#000000", "#ffffff"));
    expect(contrastRatio("#808080", "#808080")).toBeCloseTo(1, 5);
  });

  it("matches the known white-on-black ratio of 21:1", () => {
    expect(contrastRatio("#ffffff", "#000000")).toBeCloseTo(21, 0);
  });
});
