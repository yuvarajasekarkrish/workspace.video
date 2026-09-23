import type { RoomLayout } from "./types";
import { deskGrid, benchTable, meetingRoom, standupArea, allHands, privateCabin, collabTables, kitchen, lounge, mergeModules } from "./modules";

/**
 * A bigger office for 300+ people, in the arrangement the owner picked (2026-09-23), shaped wide (20 x 11 tiles) to
 * fill a laptop or monitor screen rather than sit in a square box in the middle of it. Everything is on one clean
 * grid, so every area lines up with its neighbours:
 *
 *   columns 0-3 | 4-7 | 8-11 | 12-15 | 16-19;  rows 0-3 | 4-7 | 8-10
 *   top:    boardroom | all-hands auditorium | meeting room | standup | 4 private cabins
 *   middle: desks     | desks                | desks        | collaboration tables | 4 private cabins
 *   bottom: 2 benches | lounge               | kitchen      | 2 benches | lounge
 *
 * Built only from the shared modules, so every seat, zone and sitting rule is worked out exactly as for openOffice@1.
 */
function build(): RoomLayout {
  const cabins = [0, 1, 2, 3].flatMap((r) =>
    [0, 1].map((c) => {
      const n = r * 2 + c + 1;
      return privateCabin(`cabin-${n}`, { col: 16 + c * 2, row: r * 2, cols: 2, rows: 2 }, { label: `Private Cabin ${n}` });
    }),
  );
  const combined = mergeModules(
    meetingRoom("meet-a", { col: 0, row: 0, cols: 4, rows: 4 }, { label: "Boardroom", capacity: 20 }),
    allHands("all-hands", { col: 4, row: 0, cols: 4, rows: 4 }, { rows: 6, cols: 12 }),
    meetingRoom("meet-b", { col: 8, row: 0, cols: 4, rows: 4 }, { label: "Meeting Room B", capacity: 20 }),
    standupArea("standup", { col: 12, row: 0, cols: 4, rows: 4 }, { capacity: 16 }),
    ...cabins,

    deskGrid("floor", { col: 0, row: 4, cols: 4, rows: 4 }, { cols: 4, rows: 5, startNumber: 1 }),
    deskGrid("floor-b", { col: 4, row: 4, cols: 4, rows: 4 }, { cols: 4, rows: 5, startNumber: 21 }),
    deskGrid("floor-c", { col: 8, row: 4, cols: 4, rows: 4 }, { cols: 4, rows: 5, startNumber: 41 }),
    collabTables("collab", { col: 12, row: 4, cols: 4, rows: 4 }, { tableCount: 4, chairsPerTable: 8, aligned: true }),

    benchTable("bench-1", { col: 0, row: 8, cols: 2, rows: 3 }, "Bench 1"),
    benchTable("bench-2", { col: 2, row: 8, cols: 2, rows: 3 }, "Bench 2"),
    lounge("lounge", { col: 4, row: 8, cols: 4, rows: 3 }, { seatCount: 12 }),
    kitchen("kitchen", { col: 8, row: 8, cols: 4, rows: 3 }, { stoolCount: 10 }),
    benchTable("bench-3", { col: 12, row: 8, cols: 2, rows: 3 }, "Bench 3"),
    benchTable("bench-4", { col: 14, row: 8, cols: 2, rows: 3 }, "Bench 4"),
    lounge("lounge-b", { col: 16, row: 8, cols: 4, rows: 3 }, { seatCount: 12 }),
  );

  return {
    id: "office300@1",
    floor: { cols: 20, rows: 11 },
    spawnZoneId: "lounge-zone",
    ...combined,
  };
}

export const office300: RoomLayout = build();
