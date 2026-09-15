import { describe, it, expect } from "vitest";
import { openOffice1 } from "../openOffice";
import { validateLayout } from "../validate";

describe("openOffice1", () => {
  it("passes structural validation", () => {
    const result = validateLayout(openOffice1);
    if (!result.valid) {
      // Surface the actual errors in the failure message rather than just "false".
      expect(result.errors).toEqual([]);
    }
    expect(result.valid).toBe(true);
  });

  it("matches the approved design's seat counts per area", () => {
    const byLabelPrefix = (prefix: string) => openOffice1.seats.filter((s) => s.label.startsWith(prefix)).length;

    expect(byLabelPrefix("Desk ")).toBe(36); // 18 two-person desks
    expect(byLabelPrefix("Bench 19")).toBe(4);
    expect(byLabelPrefix("Bench 20")).toBe(4);
    expect(byLabelPrefix("Meeting Room A")).toBe(20);
    expect(byLabelPrefix("All Hands")).toBe(40);
    expect(byLabelPrefix("Standup Area")).toBe(20);
    expect(byLabelPrefix("Collaboration")).toBe(24); // 3 tables x 8
    expect(byLabelPrefix("Kitchen")).toBe(6);
    expect(byLabelPrefix("Private Cabin")).toBe(12); // 6 cabins x 2
    expect(byLabelPrefix("Lounge")).toBe(9);

    expect(openOffice1.seats.length).toBe(175);
  });

  it("has exactly 18 individually numbered desks, 1 through 18", () => {
    const deskSeats = openOffice1.seats.filter((s) => /^Desk \d+$/.test(s.label));
    const numbers = new Set(deskSeats.map((s) => Number(s.label.replace("Desk ", ""))));
    expect(numbers.size).toBe(18);
    expect(Math.min(...numbers)).toBe(1);
    expect(Math.max(...numbers)).toBe(18);
  });

  it("gives every desk exactly two seats", () => {
    const byDesk = new Map<string, number>();
    for (const seat of openOffice1.seats) {
      if (!/^Desk \d+$/.test(seat.label)) continue;
      byDesk.set(seat.label, (byDesk.get(seat.label) ?? 0) + 1);
    }
    expect([...byDesk.values()].every((n) => n === 2)).toBe(true);
  });

  it("gives each bench exactly four seats in the same open zone", () => {
    for (const label of ["Bench 19", "Bench 20"]) {
      const seats = openOffice1.seats.filter((s) => s.label === label);
      expect(seats).toHaveLength(4);
      const zoneIds = new Set(seats.map((s) => s.zoneId));
      expect(zoneIds.size).toBe(1);
    }
  });

  it("every audience seat belongs to the audience zone, and the audience zone points at a real stage", () => {
    const audienceZone = openOffice1.zones.find((z) => z.kind === "audience");
    expect(audienceZone).toBeDefined();
    const stage = openOffice1.zones.find((z) => z.id === audienceZone!.stageId);
    expect(stage?.kind).toBe("stage");

    const audienceSeats = openOffice1.seats.filter((s) => s.zoneId === audienceZone!.id);
    expect(audienceSeats).toHaveLength(40);
  });

  it("spawnZoneId resolves to a real zone in the layout", () => {
    const zone = openOffice1.zones.find((z) => z.id === openOffice1.spawnZoneId);
    expect(zone).toBeDefined();
  });

  it("layouts do not depend on plans.ts (architectural independence)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = path.join(__dirname, "..");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".ts") && !f.includes("__tests__"));
    for (const file of files) {
      const contents = fs.readFileSync(path.join(dir, file), "utf-8");
      expect(contents).not.toMatch(/from ["'].*plans["']/);
      expect(contents).not.toMatch(/from ["']@cosmos\/shared["']/);
    }
  });
});
