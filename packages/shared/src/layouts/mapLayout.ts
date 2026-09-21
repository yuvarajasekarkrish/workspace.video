import type { LayoutZone, RoomLayout, Seat, TileRect } from "./types";
import { tileRectToWorld } from "./grid";
import { meetingRoom, mergeModules, type ModuleResult } from "./modules";

/**
 * The spatial map (the owner's Gemini design, docs/designs/gemini-landing.html.html) written as data
 * the realtime engine can run.
 *
 * A map area is a rectangle on the engine's 160 px grid (the same grid the zones already use), so
 * a company's builder saves a list of these and the engine needs no new concept: an area becomes
 * an engine zone, a desk pod becomes four seats. The coordinates are the same units the screen
 * draws, so a click on the map and a position on the server agree. Scale check (from the numbers):
 * the map's seats are 124 px apart top to bottom and its pods are 180 px apart, against 116 and
 * 160 in openOffice@1, so it needs no rescaling.
 *
 *   MapZone (rect on the grid) ---> engine zone            desk pod (140 px, seats marked o)
 *   desks    -> "open"  + 4 seats per pod                   +-----------+
 *   creative -> "open"  (no seats)                          | o       o |
 *   hub      -> "lobby" (where people arrive)               |           |
 *   cafe     -> "open"  + one seat per stool                | o       o |
 *   meeting  -> "meeting" (table + chairs, from modules)    +-----------+
 *   focus    -> "focus" + one seat per desk
 *
 * Furniture is drawn by the screen, not by the engine, so the layout carries only what the
 * meeting-room module adds.
 */

export type MapZoneKind = "desks" | "creative" | "hub" | "cafe" | "meeting" | "focus";

export interface MapZone {
  id: string;
  type: MapZoneKind;
  name: string;
  rect: TileRect;
  /** How many people the area is drawn for. Advisory, like LayoutZone.capacity. */
  targetUsers: number;
}

// The sizes the map draws (LandingPage.tsx buildScene): pods 140 px wide on a 180 px pitch,
// inset 20 px, with a walkway after every second pod.
const POD_PITCH = 180;
const POD_INSET = 20;
const POD_SEATS = [
  { x: 43, y: 8 },
  { x: 43, y: 132 },
  { x: 93, y: 8 },
  { x: 93, y: 132 },
];
const FOCUS_ROWS = 2;
const FOCUS_COLS = 4;
const STOOL_COUNT = 5;

const zoneIdOf = (zone: MapZone) => `${zone.id}-zone`;

function areaZone(zone: MapZone, kind: LayoutZone["kind"]): LayoutZone {
  return { id: zoneIdOf(zone), label: zone.name, kind, rect: zone.rect, capacity: zone.targetUsers };
}

/** Where an area's desk pods sit, in pixels from the area's top-left corner, with their row and
 *  column. Used both to place the seats and to count them before anything is built. */
function deskPodCells(rect: TileRect): { r: number; c: number; left: number; top: number }[] {
  const box = tileRectToWorld(rect);
  const cols = Math.floor(box.width / POD_PITCH);
  const rows = Math.floor(box.height / POD_PITCH);
  const padX = (box.width - cols * POD_PITCH) / 2;
  const padY = (box.height - rows * POD_PITCH) / 2;
  const cells: { r: number; c: number; left: number; top: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c % 3 === 2) continue; // a walkway after every second pod
      cells.push({ r, c, left: padX + c * POD_PITCH + POD_INSET, top: padY + r * POD_PITCH + POD_INSET });
    }
  }
  return cells;
}

function deskArea(zone: MapZone): ModuleResult {
  const box = tileRectToWorld(zone.rect);
  const seats: Seat[] = [];
  deskPodCells(zone.rect).forEach((cell, i) => {
    POD_SEATS.forEach((seat, k) => {
      seats.push({
        id: `${zone.id}-pod-${cell.r}-${cell.c}-${k}`,
        label: `${zone.name} pod ${i + 1}`,
        anchor: { x: box.x + cell.left + seat.x, y: box.y + cell.top + seat.y },
        zoneId: zoneIdOf(zone),
      });
    });
  });
  return { furniture: [], seats, zones: [areaZone(zone, "open")] };
}

/** How many seats a list of areas will have, worked out without building them, so a map that would
 *  be far too large can be refused cheaply. Uses the same code that builds them. */
export function estimateMapSeats(zones: readonly MapZone[]): number {
  let total = 0;
  for (const zone of zones) {
    switch (zone.type) {
      case "desks":
        total += deskPodCells(zone.rect).length * POD_SEATS.length;
        break;
      case "focus":
        total += FOCUS_ROWS * FOCUS_COLS;
        break;
      case "cafe":
        total += STOOL_COUNT;
        break;
      case "meeting":
        total += meetingRoom(zone.id, zone.rect, { label: zone.name, capacity: zone.targetUsers }).seats.length;
        break;
      default:
        break; // hub and creative areas have no seats
    }
  }
  return total;
}

function focusArea(zone: MapZone): ModuleResult {
  const box = tileRectToWorld(zone.rect);
  const seats: Seat[] = [];
  for (let r = 0; r < FOCUS_ROWS; r++) {
    for (let c = 0; c < FOCUS_COLS; c++) {
      seats.push({
        id: `${zone.id}-desk-${r}-${c}`,
        label: `${zone.name} desk ${r * FOCUS_COLS + c + 1}`,
        anchor: { x: box.x + 50 + c * 140 + 45, y: box.y + 40 + r * 110 + 60 },
        zoneId: zoneIdOf(zone),
      });
    }
  }
  return { furniture: [], seats, zones: [areaZone(zone, "focus")] };
}

function cafeArea(zone: MapZone): ModuleResult {
  const box = tileRectToWorld(zone.rect);
  const seats: Seat[] = [];
  for (let i = 0; i < STOOL_COUNT; i++) {
    seats.push({
      id: `${zone.id}-stool-${i}`,
      label: `${zone.name} stool ${i + 1}`,
      anchor: { x: box.x + 100 + i * 70, y: box.y + 120 },
      zoneId: zoneIdOf(zone),
    });
  }
  return { furniture: [], seats, zones: [areaZone(zone, "open")] };
}

function convert(zone: MapZone): ModuleResult {
  switch (zone.type) {
    case "desks":
      return deskArea(zone);
    case "focus":
      return focusArea(zone);
    case "cafe":
      return cafeArea(zone);
    case "meeting":
      // The existing, tested module: a table with chairs around it, in a "meeting" zone.
      return meetingRoom(zone.id, zone.rect, { label: zone.name, capacity: zone.targetUsers });
    case "hub":
      return { furniture: [], seats: [], zones: [areaZone(zone, "lobby")] };
    case "creative":
      return { furniture: [], seats: [], zones: [areaZone(zone, "open")] };
  }
}

/** Turns what a company's builder saves (a list of areas) into a layout the engine can run. */
export function layoutFromMapZones(id: string, zones: readonly MapZone[]): RoomLayout {
  if (zones.length === 0) throw new Error("A map needs at least one area, so people have somewhere to arrive.");
  const combined = mergeModules(...zones.map(convert));
  const hub = zones.find((z) => z.type === "hub") ?? zones[0]!;
  return {
    id,
    floor: {
      cols: Math.max(...zones.map((z) => z.rect.col + z.rect.cols)),
      rows: Math.max(...zones.map((z) => z.rect.row + z.rect.rows)),
    },
    spawnZoneId: zoneIdOf(hub),
    ...combined,
  };
}

/** The starter map: the Gemini design's nine areas, on the engine's grid. */
export const SPATIAL_MAP_DEFAULT_ZONES: readonly MapZone[] = [
  { id: "eng", type: "desks", name: "Engineering", rect: { col: 1, row: 1, cols: 6, rows: 3 }, targetUsers: 45 },
  { id: "prod", type: "desks", name: "Product Team", rect: { col: 8, row: 1, cols: 5, rows: 3 }, targetUsers: 30 },
  { id: "design", type: "creative", name: "Design Studio", rect: { col: 14, row: 1, cols: 4, rows: 4 }, targetUsers: 20 },
  { id: "sales", type: "desks", name: "Sales & Marketing", rect: { col: 1, row: 5, cols: 5, rows: 3 }, targetUsers: 35 },
  { id: "hub", type: "hub", name: "Welcome Plaza", rect: { col: 8, row: 4, cols: 5, rows: 4 }, targetUsers: 24 },
  { id: "cafe", type: "cafe", name: "Main Lounge", rect: { col: 13, row: 6, cols: 5, rows: 4 }, targetUsers: 20 },
  { id: "meet_1", type: "meeting", name: "Boardroom", rect: { col: 1, row: 9, cols: 3, rows: 3 }, targetUsers: 8 },
  { id: "meet_2", type: "meeting", name: "Sync A", rect: { col: 4, row: 9, cols: 2, rows: 2 }, targetUsers: 4 },
  { id: "focus_pod", type: "focus", name: "Focus Pods", rect: { col: 7, row: 9, cols: 4, rows: 2 }, targetUsers: 14 },
];

export const spatialMap1: RoomLayout = layoutFromMapZones("spatialMap@1", SPATIAL_MAP_DEFAULT_ZONES);
