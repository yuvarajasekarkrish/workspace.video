import { z } from "zod";
import type { RoomLayout } from "./types";
import { DEFAULT_LAYOUT_ID, resolveLayout } from "./registry";
import { estimateMapSeats, layoutFromMapZones, type MapZone } from "./mapLayout";
import { validateLayout } from "./validate";

/**
 * A company's own map, as the admin panel saves it in the room's settings (`Room.config.map`),
 * and the one function that decides which layout a room uses. See
 * docs/architecture/company-map-builder.md (decisions D1, D6, D7, D8).
 *
 * The map is untrusted input, so it is checked when saved and again when loaded. A stored map that
 * fails the checks never changes the office silently: `resolveRoomLayout` falls back to the room's
 * named layout (or the default) and reports why in `problem`.
 *
 *   Room.config ──► resolveRoomLayout ──► { layout, source, problem? }
 *      map valid?    yes ─► the company's map                       source "map"
 *                    no  ─► named layout, if known                   source "layoutId"   (+ problem if a
 *                    none ─► default office                          source "default"     map was broken)
 */

/** The biggest floor, in tiles: 50 x 160 px = 8,000 px, the engine's own room limit. */
export const MAX_FLOOR_TILES = 50;
export const MAX_MAP_ZONES = 60;
/** Proposed; not measured above the 105 seats and 100 people we have tested. */
export const MAX_MAP_SEATS = 400;
export const MAX_NAME_LENGTH = 60;
export const ROOM_MAP_VERSION = 1;

const TileRectSchema = z.object({
  col: z.number().int("position must be a whole number of tiles").min(0, "position cannot be negative"),
  row: z.number().int("position must be a whole number of tiles").min(0, "position cannot be negative"),
  cols: z.number().int("size must be a whole number of tiles").min(1, "size must be at least one tile"),
  rows: z.number().int("size must be a whole number of tiles").min(1, "size must be at least one tile"),
});

const MapZoneSchema = z.object({
  id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, "id must be 1 to 40 letters, digits, dashes or underscores"),
  type: z.enum(["desks", "creative", "hub", "cafe", "meeting", "focus"]),
  name: z.string().trim().min(1, "name cannot be empty").max(MAX_NAME_LENGTH, `name can be at most ${MAX_NAME_LENGTH} characters`),
  rect: TileRectSchema,
  targetUsers: z.number().int().min(0).max(200),
});

export const RoomMapSchema = z.object({
  version: z.literal(ROOM_MAP_VERSION, { errorMap: () => ({ message: `version must be ${ROOM_MAP_VERSION}` }) }),
  zones: z
    .array(MapZoneSchema)
    .min(1, "A map needs at least one area")
    .max(MAX_MAP_ZONES, `A map can have at most ${MAX_MAP_ZONES} areas`),
});

export type RoomMap = { version: 1; zones: MapZone[] };

export type RoomMapResult = { ok: true; map: RoomMap; layout: RoomLayout } | { ok: false; errors: string[] };

/** Checks a map from the admin panel or from storage. Returns every problem found, in plain words. */
export function validateRoomMap(input: unknown): RoomMapResult {
  const parsed = RoomMapSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => (issue.path.length > 0 ? `${issue.path.join(".")}: ${issue.message}` : issue.message)),
    };
  }
  const map = parsed.data as RoomMap;
  const errors: string[] = [];

  if (map.zones.filter((z) => z.type === "hub").length > 1) {
    errors.push("A map can have only one arrival area (the plaza).");
  }
  const reachCols = Math.max(...map.zones.map((z) => z.rect.col + z.rect.cols));
  const reachRows = Math.max(...map.zones.map((z) => z.rect.row + z.rect.rows));
  if (reachCols > MAX_FLOOR_TILES || reachRows > MAX_FLOOR_TILES) {
    errors.push(`The map is larger than the floor allows: it reaches ${reachCols} x ${reachRows} tiles and the most is ${MAX_FLOOR_TILES} x ${MAX_FLOOR_TILES}.`);
  }
  // Counted before anything is built, so an oversized map costs almost nothing to refuse.
  if (errors.length === 0) {
    const seats = estimateMapSeats(map.zones);
    if (seats > MAX_MAP_SEATS) errors.push(`This map has ${seats} seats and the most is ${MAX_MAP_SEATS}.`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const layout = layoutFromMapZones("custom", map.zones);
  const structural = validateLayout(layout);
  if (!structural.valid) return { ok: false, errors: structural.errors };
  return { ok: true, map, layout };
}

export interface ResolvedLayout {
  layout: RoomLayout;
  /** Where the layout came from: the company's map, a named layout, or the default office. */
  source: "map" | "layoutId" | "default";
  /** Set when a stored map was refused; says why, so it can be logged and shown to the admin. */
  problem?: string;
}

/** The one place a room's layout is decided. Never throws, whatever is stored. */
export function resolveRoomLayout(config: unknown): ResolvedLayout {
  const settings = typeof config === "object" && config !== null && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
  const named = typeof settings.layoutId === "string" ? resolveLayout(settings.layoutId) : null;
  const base: ResolvedLayout = named
    ? { layout: named, source: "layoutId" }
    : { layout: resolveLayout(DEFAULT_LAYOUT_ID)!, source: "default" };

  if (settings.map === undefined) return base;
  const result = validateRoomMap(settings.map);
  if (result.ok) return { layout: result.layout, source: "map" };
  return { ...base, problem: result.errors.join(" ") };
}
