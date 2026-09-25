import { describe, it, expect } from "vitest";
import { freeSeatsInOrder, nearbyFreeSeats, type SelectableSeat } from "../seatSelection";

const seat = (id: string, x: number, y: number): SelectableSeat => ({ id, anchor: { x, y } });

describe("freeSeatsInOrder", () => {
  const table = [seat("desk-1-a", 0, 0), seat("desk-1-b", 100, 0)];

  it("returns every candidate when none are occupied", () => {
    expect(freeSeatsInOrder(table, () => undefined, "u1").map((s) => s.id)).toEqual(["desk-1-a", "desk-1-b"]);
  });

  it("excludes a seat occupied by someone else", () => {
    const occupantOf = (id: string) => (id === "desk-1-a" ? "other-user" : undefined);
    expect(freeSeatsInOrder(table, occupantOf, "u1").map((s) => s.id)).toEqual(["desk-1-b"]);
  });

  it("treats the requesting user's own current seat as free (a no-op re-select)", () => {
    const occupantOf = (id: string) => (id === "desk-1-a" ? "u1" : undefined);
    expect(freeSeatsInOrder(table, occupantOf, "u1").map((s) => s.id)).toEqual(["desk-1-a", "desk-1-b"]);
  });

  it("returns an empty array when every seat is taken by someone else — a full table", () => {
    const occupantOf = () => "other-user";
    expect(freeSeatsInOrder(table, occupantOf, "u1")).toEqual([]);
  });

  it("preserves the given order — no randomization of which free seat comes first", () => {
    const table5 = [seat("t-1", 0, 0), seat("t-2", 1, 0), seat("t-3", 2, 0), seat("t-4", 3, 0), seat("t-5", 4, 0)];
    const occupantOf = (id: string) => (id === "t-2" || id === "t-4" ? "other" : undefined);
    expect(freeSeatsInOrder(table5, occupantOf, "u1").map((s) => s.id)).toEqual(["t-1", "t-3", "t-5"]);
  });
});

describe("nearbyFreeSeats", () => {
  const seats = [seat("near", 10, 0), seat("mid", 50, 0), seat("far", 500, 0)];

  it("returns only seats within radius, nearest first", () => {
    const result = nearbyFreeSeats(seats, { x: 0, y: 0 }, 100, () => undefined, "u1");
    expect(result.map((s) => s.id)).toEqual(["near", "mid"]);
  });

  it("excludes an occupied seat even if it's the nearest", () => {
    const occupantOf = (id: string) => (id === "near" ? "other" : undefined);
    const result = nearbyFreeSeats(seats, { x: 0, y: 0 }, 100, occupantOf, "u1");
    expect(result.map((s) => s.id)).toEqual(["mid"]);
  });

  it("returns an empty array when nothing is within radius", () => {
    expect(nearbyFreeSeats(seats, { x: 0, y: 0 }, 5, () => undefined, "u1")).toEqual([]);
  });

  it("includes the requesting user's own occupied seat within radius", () => {
    const occupantOf = (id: string) => (id === "near" ? "u1" : undefined);
    const result = nearbyFreeSeats(seats, { x: 0, y: 0 }, 100, occupantOf, "u1");
    expect(result.map((s) => s.id)).toEqual(["near", "mid"]);
  });
});
