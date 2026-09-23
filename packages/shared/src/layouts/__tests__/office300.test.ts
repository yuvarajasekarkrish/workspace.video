import { describe, it, expect } from "vitest";
import { deskBank } from "../modules";
import { office300 } from "../office300";
import { validateLayout } from "../validate";
import { resolveLayout } from "../registry";

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
  it("passes the layout checks and seats at least 300 people", () => {
    expect(validateLayout(office300)).toEqual({ valid: true });
    expect(office300.seats.length).toBeGreaterThanOrEqual(300);
  });

  it("is in the registry, so a room can choose it", () => {
    expect(resolveLayout("office300@1")).toBe(office300);
  });
});
