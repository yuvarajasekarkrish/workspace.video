import type { RoomLayout, TileRect } from "./types";
import { tileRectToWorld } from "./grid";

export type LayoutValidationResult = { valid: true } | { valid: false; errors: string[] };

function tilesOverlap(a: TileRect, b: TileRect): boolean {
  return a.col < b.col + b.cols && b.col < a.col + a.cols && a.row < b.row + b.rows && b.row < a.row + a.rows;
}

function findDuplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  return Array.from(dupes);
}

const ZONE_KINDS_THAT_MUST_NOT_OVERLAP = new Set(["meeting", "cabin", "stage", "audience"]);

/**
 * Structural invariants a RoomLayout must satisfy, checked once at
 * definition time (via each layout's test file) rather than at runtime —
 * a layout is static, product-authored data, not user input, so this is a
 * build-time correctness check, not a request-time validation gate.
 */
export function validateLayout(layout: RoomLayout): LayoutValidationResult {
  const errors: string[] = [];
  const floorWidthPx = layout.floor.cols;
  const floorHeightPx = layout.floor.rows;

  const dupFurniture = findDuplicates(layout.furniture.map((f) => f.id));
  if (dupFurniture.length > 0) errors.push(`Duplicate furniture ids: ${dupFurniture.join(", ")}`);

  const dupSeats = findDuplicates(layout.seats.map((s) => s.id));
  if (dupSeats.length > 0) errors.push(`Duplicate seat ids: ${dupSeats.join(", ")}`);

  const dupZones = findDuplicates(layout.zones.map((z) => z.id));
  if (dupZones.length > 0) errors.push(`Duplicate zone ids: ${dupZones.join(", ")}`);

  const floorPxW = floorWidthPx * 160;
  const floorPxH = floorHeightPx * 160;
  for (const f of layout.furniture) {
    if (f.x < 0 || f.y < 0 || f.x + f.width > floorPxW || f.y + f.height > floorPxH) {
      errors.push(`Furniture "${f.id}" lies outside the floor bounds`);
    }
  }
  for (const s of layout.seats) {
    if (s.anchor.x < 0 || s.anchor.y < 0 || s.anchor.x > floorPxW || s.anchor.y > floorPxH) {
      errors.push(`Seat "${s.id}" anchor lies outside the floor bounds`);
    }
  }
  for (const z of layout.zones) {
    const box = tileRectToWorld(z.rect);
    if (z.rect.col < 0 || z.rect.row < 0 || box.x + box.width > floorPxW || box.y + box.height > floorPxH) {
      errors.push(`Zone "${z.id}" rect lies outside the floor bounds`);
    }
  }

  const zoneById = new Map(layout.zones.map((z) => [z.id, z]));

  const constrained = layout.zones.filter((z) => ZONE_KINDS_THAT_MUST_NOT_OVERLAP.has(z.kind));
  for (let i = 0; i < constrained.length; i++) {
    for (let j = i + 1; j < constrained.length; j++) {
      if (tilesOverlap(constrained[i]!.rect, constrained[j]!.rect)) {
        errors.push(`Zones "${constrained[i]!.id}" and "${constrained[j]!.id}" overlap`);
      }
    }
  }

  if (!zoneById.has(layout.spawnZoneId)) {
    errors.push(`spawnZoneId "${layout.spawnZoneId}" does not resolve to a zone`);
  }

  for (const zone of layout.zones) {
    if (zone.kind === "audience") {
      if (!zone.stageId) {
        errors.push(`Audience zone "${zone.id}" has no stageId`);
      } else if (zoneById.get(zone.stageId)?.kind !== "stage") {
        errors.push(`Audience zone "${zone.id}"'s stageId "${zone.stageId}" does not resolve to a stage zone`);
      }
    }
  }

  for (const seat of layout.seats) {
    if (seat.zoneId && !zoneById.has(seat.zoneId)) {
      errors.push(`Seat "${seat.id}"'s zoneId "${seat.zoneId}" does not resolve to a zone`);
    }
  }

  return errors.length === 0 ? { valid: true } : { valid: false, errors };
}
