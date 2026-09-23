import type { RoomLayout } from "./types";
import {
  angledDeskPod,
  benchRows,
  phoneBooth,
  roundTable,
  roundLounge,
  meetingRoom,
  lounge,
  kitchen,
  mergeModules,
} from "./modules";

/**
 * The 200-person richly-furnished template from the owner's reference
 * images, built from the new pieces added this session (angledDeskPod,
 * benchRows, phoneBooth, roundTable, roundLounge) plus existing blocks that
 * already matched the references as-is (meetingRoom for the oval table,
 * kitchen, lounge). Additive per rule 19/20 — never replaces `openOffice1`,
 * selected only via its own layout id.
 *
 * Every tile rect below is placed by hand on the same non-overlapping-grid
 * discipline as `openOffice.ts` (each module gets its own exclusive
 * col/row block, verified by professional200.test.ts's full pairwise
 * furniture-overlap check across the ENTIRE assembled layout, not just
 * within one module — the real answer to "does this actually fit without
 * collisions," not an eyeballed one).
 *
 * Grid: 18 cols x 16 rows at TILE_PX.
 *   rows 0-3:   auditorium (cols 0-9) + kitchen (cols 10-17)
 *   rows 4-11:  16 angled desk pods (cols 0-11) + 6 phone booths (cols 12-15)
 *               + 4 private-cabin round tables (cols 16-17)
 *   rows 12-15: round lounge pit (cols 0-5) + 4 reception round tables
 *               (cols 6-9) + 2 meeting rooms (cols 10-13) + lounge (cols 14-17,
 *               with 4x2 tiles left open as circulation space, not crammed full)
 *
 * Seat total: 80 (auditorium) + 128 (16 pods x 8) + 24 (4 cabin tables x 6)
 *   + 16 (round lounge) + 16 (4 reception tables x 4) + 16 (2 meeting rooms
 *   x 8) + 9 (lounge) + 12 (kitchen) = 301 real seats, comfortably above the
 *   200-person plan cap (packages/shared/src/plans.ts) with deliberate
 *   headroom — real offices always have more nominal seats than the
 *   concurrent-user cap, since not everyone sits at once (matches
 *   openOffice1's own ratio: ~175 seats for a much smaller headcount tier).
 *   Phone booths add 6 more standing-capacity spots, not counted as seats.
 */
function build(): RoomLayout {
  const pods = [];
  for (let r = 0; r < 4; r++) {
    for (let c = 0; c < 4; c++) {
      const n = r * 4 + c + 1;
      pods.push(angledDeskPod(`pod-${n}`, { col: c * 3, row: 4 + r * 2, cols: 3, rows: 2 }, (n - 1) * 8 + 1));
    }
  }

  const booths = [
    phoneBooth("booth-1", { col: 12, row: 4, cols: 2, rows: 2 }),
    phoneBooth("booth-2", { col: 12, row: 6, cols: 2, rows: 2 }),
    phoneBooth("booth-3", { col: 12, row: 8, cols: 2, rows: 2 }),
    phoneBooth("booth-4", { col: 14, row: 4, cols: 2, rows: 2 }),
    phoneBooth("booth-5", { col: 14, row: 6, cols: 2, rows: 2 }),
    phoneBooth("booth-6", { col: 14, row: 8, cols: 2, rows: 2 }),
  ];

  const cabinTables = [
    roundTable("cabin-table-1", { col: 16, row: 4, cols: 2, rows: 2 }, { label: "Cabin Table 1", seatCount: 6 }),
    roundTable("cabin-table-2", { col: 16, row: 6, cols: 2, rows: 2 }, { label: "Cabin Table 2", seatCount: 6 }),
    roundTable("cabin-table-3", { col: 16, row: 8, cols: 2, rows: 2 }, { label: "Cabin Table 3", seatCount: 6 }),
    roundTable("cabin-table-4", { col: 16, row: 10, cols: 2, rows: 2 }, { label: "Cabin Table 4", seatCount: 6 }),
  ];

  const receptionTables = [
    roundTable("reception-1", { col: 6, row: 12, cols: 2, rows: 2 }, { label: "Reception 1", seatCount: 4, zoneKind: "open" }),
    roundTable("reception-2", { col: 8, row: 12, cols: 2, rows: 2 }, { label: "Reception 2", seatCount: 4, zoneKind: "open" }),
    roundTable("reception-3", { col: 6, row: 14, cols: 2, rows: 2 }, { label: "Reception 3", seatCount: 4, zoneKind: "open" }),
    roundTable("reception-4", { col: 8, row: 14, cols: 2, rows: 2 }, { label: "Reception 4", seatCount: 4, zoneKind: "open" }),
  ];

  const meetingRooms = [
    meetingRoom("meet-a", { col: 10, row: 12, cols: 4, rows: 2 }, { label: "Meeting Room A", capacity: 8 }),
    meetingRoom("meet-b", { col: 10, row: 14, cols: 4, rows: 2 }, { label: "Meeting Room B", capacity: 8 }),
  ];

  const combined = mergeModules(
    benchRows("auditorium", { col: 0, row: 0, cols: 10, rows: 4 }, { rows: 8, seatsPerRow: 10 }),
    kitchen("kitchen", { col: 10, row: 0, cols: 8, rows: 4 }, { stoolCount: 12 }),
    ...pods,
    ...booths,
    ...cabinTables,
    roundLounge("lounge-pit", { col: 0, row: 12, cols: 6, rows: 4 }, { segments: 8, seatsPerSegment: 2 }),
    ...receptionTables,
    ...meetingRooms,
    lounge("lounge-straight", { col: 14, row: 12, cols: 4, rows: 2 }, { seatCount: 9 }),
  );

  return {
    id: "professional200@1",
    floor: { cols: 18, rows: 16 },
    // The lounge pit is the calmest open area with no formal meeting
    // semantics — same reasoning openOffice1 uses for its own lounge.
    spawnZoneId: "lounge-pit-zone",
    ...combined,
  };
}

export const professional200: RoomLayout = build();
