import type { RoomLayout } from "./types";
import {
  deskGrid,
  benchTable,
  meetingRoom,
  standupArea,
  allHands,
  privateCabin,
  collabTables,
  kitchen,
  lounge,
  mergeModules,
} from "./modules";

/**
 * The one office floor every workspace shares (see the plan's central
 * decision: layout and subscription capacity are independent — the same
 * `openOffice@1` serves a 10-person and a 200-person workspace). Matches
 * the approved design canvas exactly: Meeting Room A / All Hands / Standup
 * Area across the top, two-person desks + a pair of 4-person benches on the
 * left, staggered collaboration tables + a kitchen in the middle, six
 * private cabins + a lounge on the right.
 *
 * Grid: 11 cols x 11 rows at TILE_PX (see grid.ts) — left column 4 tiles
 * wide, middle 3, right 4; top band 3 rows tall, everything below it 8.
 */
function build(): RoomLayout {
  const combined = mergeModules(
    meetingRoom("meet-a", { col: 0, row: 0, cols: 4, rows: 3 }, { label: "Meeting Room A", capacity: 20 }),
    allHands("all-hands", { col: 4, row: 0, cols: 3, rows: 3 }, { rows: 4, cols: 10 }),
    standupArea("standup", { col: 7, row: 0, cols: 4, rows: 3 }, { capacity: 20 }),

    deskGrid("floor", { col: 0, row: 3, cols: 3, rows: 6 }, { cols: 3, rows: 6, startNumber: 1 }),
    benchTable("bench-19", { col: 0, row: 9, cols: 2, rows: 2 }, "Bench 19"),
    benchTable("bench-20", { col: 2, row: 9, cols: 2, rows: 2 }, "Bench 20"),

    collabTables("collab", { col: 4, row: 3, cols: 3, rows: 5 }, { tableCount: 3, chairsPerTable: 8 }),
    kitchen("kitchen", { col: 4, row: 8, cols: 3, rows: 3 }, { stoolCount: 6 }),

    privateCabin("cabin-1", { col: 7, row: 3, cols: 2, rows: 2 }, { label: "Private Cabin 1" }),
    privateCabin("cabin-2", { col: 9, row: 3, cols: 2, rows: 2 }, { label: "Private Cabin 2" }),
    privateCabin("cabin-3", { col: 7, row: 5, cols: 2, rows: 2 }, { label: "Private Cabin 3" }),
    privateCabin("cabin-4", { col: 9, row: 5, cols: 2, rows: 2 }, { label: "Private Cabin 4" }),
    privateCabin("cabin-5", { col: 7, row: 7, cols: 2, rows: 2 }, { label: "Private Cabin 5" }),
    privateCabin("cabin-6", { col: 9, row: 7, cols: 2, rows: 2 }, { label: "Private Cabin 6" }),
    lounge("lounge", { col: 7, row: 9, cols: 4, rows: 2 }, { seatCount: 9 }),
  );

  return {
    id: "openOffice@1",
    floor: { cols: 11, rows: 11 },
    // The lounge is the calmest open area with no formal meeting semantics —
    // a reasonable arrival point. There is no dedicated lobby zone in the
    // approved design; spawning doesn't require one, only that the id
    // resolves to a real zone (see validateLayout).
    spawnZoneId: "lounge-zone",
    ...combined,
  };
}

export const openOffice1: RoomLayout = build();
