import type { FurniturePiece, RoomLayout } from "./types";
import type { Point } from "../geometry";
import { tableGroup, mergeModules, type TableGroupSpec, type ModuleResult } from "./modules";

/**
 * Cosmic Campus — 100: a collaborative campus for exactly 100 seated people at 24 tables of four different sizes,
 * arranged in rings around a central Nexus (an arrival plaza with a small stage and two displays, no seats):
 *
 *   corners   : 8 two-seat focus tables (in pairs)
 *   wings     : 8 four-seat collab tables (a column of four on each side)
 *   top/bottom: 6 six-seat team tables (a row of three above and below the Nexus)
 *   flanks    : 2 eight-seat executive tables, left and right of the Nexus, with the most space around them
 *
 * Every table is built by `tableGroup`, so each one has an explicit table-group id, its own seats (`tableId`) and one
 * chair per seat (`seatId`). Chairs are drawn at CHAIR_VISUAL_SCALE (office300@1's are drawn at 1); `tableGroup`
 * places each chair from its DRAWN size, and each seat is exactly its chair's centre. The tables have no zone, so
 * audio around them is plain proximity, like office300's desks. Geometry is checked in cosmicCampus100.test.ts.
 * The dark look is the room canvas's own black/graphite/white palette — no new colours.
 */

export const COSMIC_CAMPUS_100_ID = "cosmicCampus100@1";
export const CHAIR_VISUAL_SCALE = 1.4;
const CHAIR_CLEARANCE_PX = 8;

type TableType = "focus" | "collab" | "team" | "executive";

export const COSMIC_TABLE_TYPES: Record<TableType, { label: string; width: number; depth: number; seats: TableGroupSpec["seats"] }> = {
  focus: { label: "Focus Table", width: 112, depth: 72, seats: { top: 1, bottom: 1, left: 0, right: 0 } },
  collab: { label: "Collab Table", width: 140, depth: 100, seats: { top: 1, bottom: 1, left: 1, right: 1 } },
  team: { label: "Team Table", width: 220, depth: 110, seats: { top: 2, bottom: 2, left: 1, right: 1 } },
  executive: { label: "Executive Table", width: 300, depth: 140, seats: { top: 3, bottom: 3, left: 1, right: 1 } },
};

const SHORT: Record<TableType, string> = { focus: "t2", collab: "t4", team: "t6", executive: "t8" };

/** Table centres, in world px on the 18 x 10 tile floor (2880 x 1600). */
const PLACEMENT: Record<TableType, Point[]> = {
  focus: [
    { x: 500, y: 230 }, { x: 700, y: 230 }, { x: 2180, y: 230 }, { x: 2380, y: 230 },
    { x: 500, y: 1370 }, { x: 700, y: 1370 }, { x: 2180, y: 1370 }, { x: 2380, y: 1370 },
  ],
  collab: [
    { x: 200, y: 200 }, { x: 200, y: 600 }, { x: 200, y: 1000 }, { x: 200, y: 1400 },
    { x: 2680, y: 200 }, { x: 2680, y: 600 }, { x: 2680, y: 1000 }, { x: 2680, y: 1400 },
  ],
  team: [
    { x: 1020, y: 230 }, { x: 1440, y: 230 }, { x: 1860, y: 230 },
    { x: 1020, y: 1370 }, { x: 1440, y: 1370 }, { x: 1860, y: 1370 },
  ],
  executive: [{ x: 760, y: 800 }, { x: 2120, y: 800 }],
};

/** The Nexus: the arrival plaza in the middle (cols 7-10, rows 3-6), a visual focal point only. The stage and
 *  displays sit at its top so its centre, where people arrive (a 60px ring around it, see spawnPositionForUser),
 *  stays open floor. */
export const NEXUS_CENTER: Point = { x: 1440, y: 800 };

function nexus(): ModuleResult {
  const cx = NEXUS_CENTER.x;
  const plant = (id: string, x: number, y: number): FurniturePiece => ({ id, kind: "plant", x: x - 16, y: y - 16, width: 32, height: 32, rotation: 0 });
  return {
    furniture: [
      { id: "nexus-stage", kind: "stage", x: cx - 110, y: 600, width: 220, height: 100, rotation: 0, label: "Nexus" },
      // Displays are drawn tall; set far enough in from the plaza's top edge that they stay on its plate.
      { id: "nexus-screen-a", kind: "screen", x: cx - 150, y: 568, width: 110, height: 10, rotation: 0 },
      { id: "nexus-screen-b", kind: "screen", x: cx + 40, y: 568, width: 110, height: 10, rotation: 0 },
      plant("nexus-plant-1", 1180, 540),
      plant("nexus-plant-2", 1700, 540),
      plant("nexus-plant-3", 1180, 1060),
      plant("nexus-plant-4", 1700, 1060),
    ],
    seats: [],
    zones: [{ id: "nexus-zone", label: "Nexus", kind: "lobby", rect: { col: 7, row: 3, cols: 4, rows: 4 } }],
  };
}

function build(): RoomLayout {
  const tables: ModuleResult[] = [];
  for (const type of ["executive", "team", "collab", "focus"] as const) {
    const spec = COSMIC_TABLE_TYPES[type];
    PLACEMENT[type].forEach((center, i) => {
      const n = String(i + 1).padStart(2, "0");
      tables.push(
        tableGroup({
          tableId: `cosmic-${SHORT[type]}-${n}`,
          label: `${spec.label} ${i + 1}`,
          center,
          width: spec.width,
          depth: spec.depth,
          seats: spec.seats,
          chairVisualScale: CHAIR_VISUAL_SCALE,
          chairClearancePx: CHAIR_CLEARANCE_PX,
        }),
      );
    });
  }
  return {
    id: COSMIC_CAMPUS_100_ID,
    floor: { cols: 18, rows: 10 },
    spawnZoneId: "nexus-zone",
    ...mergeModules(nexus(), ...tables),
  };
}

export const cosmicCampus100: RoomLayout = build();
