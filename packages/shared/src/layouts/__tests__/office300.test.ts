import { describe, it, expect } from "vitest";
import { deskBank } from "../modules";
import { office300 } from "../office300";
import { validateLayout } from "../validate";
import { resolveLayout, DEFAULT_LAYOUT_ID } from "../registry";

describe("deskBank (2- and 3-person desks)", () => {
  for (const seatsPerDesk of [2, 3] as const) {
    it(`gives every person at a ${seatsPerDesk}-person desk their own chair, with the seat exactly on it`, () => {
      const bank = deskBank("t", { col: 0, row: 0, cols: 2, rows: 2 }, { seatsPerDesk, cols: 1, rows: 1, startNumber: 1, label: "T" });
      const desks = bank.furniture.filter((f) => f.kind === "desk");
      const chairs = bank.furniture.filter((f) => f.kind === "chair");
      expect(desks).toHaveLength(2); // back to back
      expect(chairs).toHaveLength(seatsPerDesk * 2);
      expect(bank.seats).toHaveLength(seatsPerDesk * 2);
      for (const seat of bank.seats) {
        expect(chairs.some((c) => c.x + c.width / 2 === seat.anchor.x && c.y + c.height / 2 === seat.anchor.y)).toBe(true);
        expect(seat.zoneId).toBe("t-zone");
      }
      expect(bank.zones[0].capacity).toBe(seatsPerDesk * 2);
    });
  }
});

describe("office300@1", () => {
  it("passes structural validation", () => {
    const result = validateLayout(office300);
    if (!result.valid) {
      // Surface the actual errors in the failure message rather than just "false".
      expect(result.errors).toEqual([]);
    }
    expect(result.valid).toBe(true);
  });

  it("passes the layout checks and seats at least 300 people", () => {
    expect(validateLayout(office300)).toEqual({ valid: true });
    expect(office300.seats.length).toBeGreaterThanOrEqual(300);
  });

  it("is in the registry, so a room can choose it, and is the app's default", () => {
    expect(resolveLayout("office300@1")).toBe(office300);
    expect(resolveLayout(DEFAULT_LAYOUT_ID)).toBe(office300);
  });

  it("matches the approved design's seat counts per area", () => {
    const byLabelPrefix = (prefix: string) => office300.seats.filter((s) => s.label.startsWith(prefix)).length;

    expect(byLabelPrefix("Desk ")).toBe(120); // 60 two-person desks across 3 desk grids
    expect(byLabelPrefix("Bench")).toBe(16); // 4 benches x 4
    expect(byLabelPrefix("Boardroom")).toBe(20);
    expect(byLabelPrefix("Meeting Room B")).toBe(20);
    expect(byLabelPrefix("All Hands")).toBe(72);
    expect(byLabelPrefix("Standup Area")).toBe(16);
    expect(byLabelPrefix("Collaboration")).toBe(32); // 4 tables x 8
    expect(byLabelPrefix("Kitchen")).toBe(10);
    expect(byLabelPrefix("Private Cabin")).toBe(16); // 8 cabins x 2
    expect(byLabelPrefix("Lounge")).toBe(24); // 2 lounges x 12

    expect(office300.seats.length).toBe(346);
  });

  it("has exactly 60 individually numbered desks, 1 through 60, across three desk grids", () => {
    const deskSeats = office300.seats.filter((s) => /^Desk \d+$/.test(s.label));
    const numbers = new Set(deskSeats.map((s) => Number(s.label.replace("Desk ", ""))));
    expect(numbers.size).toBe(60);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(60);
  });

  it("gives every desk exactly two seats", () => {
    const byDesk = new Map<string, number>();
    for (const seat of office300.seats) {
      if (!/^Desk \d+$/.test(seat.label)) continue;
      byDesk.set(seat.label, (byDesk.get(seat.label) ?? 0) + 1);
    }
    expect([...byDesk.values()].every((n) => n === 2)).toBe(true);
  });

  it("gives each bench exactly four seats in the same open zone", () => {
    for (const label of ["Bench 1", "Bench 2", "Bench 3", "Bench 4"]) {
      const seats = office300.seats.filter((s) => s.label === label);
      expect(seats).toHaveLength(4);
      const zoneIds = new Set(seats.map((s) => s.zoneId));
      expect(zoneIds.size).toBe(1);
    }
  });

  it("every audience seat belongs to the audience zone, and the audience zone points at a real stage", () => {
    const audienceZone = office300.zones.find((z) => z.kind === "audience");
    expect(audienceZone).toBeDefined();
    const stage = office300.zones.find((z) => z.id === audienceZone!.stageId);
    expect(stage?.kind).toBe("stage");

    const audienceSeats = office300.seats.filter((s) => s.zoneId === audienceZone!.id);
    expect(audienceSeats).toHaveLength(72);
  });

  it("spawnZoneId resolves to a real zone in the layout", () => {
    const zone = office300.zones.find((z) => z.id === office300.spawnZoneId);
    expect(zone).toBeDefined();
  });

  it("has two independent meeting rooms, each a real private zone", () => {
    const meetingZones = office300.zones.filter((z) => z.kind === "meeting");
    expect(meetingZones).toHaveLength(2);
    expect(new Set(meetingZones.map((z) => z.id)).size).toBe(2);
  });

  it("has eight independent private cabins, each seating exactly two", () => {
    const cabinZones = office300.zones.filter((z) => z.kind === "cabin");
    expect(cabinZones).toHaveLength(8);
    for (const zone of cabinZones) {
      const seats = office300.seats.filter((s) => s.zoneId === zone.id);
      expect(seats).toHaveLength(2);
    }
  });
});
