import { describe, it, expect } from "vitest";
import { resolveSeatClaim, type SeatInfo } from "../seatOccupancy";

const seat: SeatInfo = { id: "desk-1-a", anchor: { x: 100, y: 100 } };

describe("resolveSeatClaim", () => {
  it("rejects an unknown seat", () => {
    const result = resolveSeatClaim(undefined, { x: 100, y: 100 }, undefined, "u1", null);
    expect(result).toEqual({ accepted: false, reason: "unknown_seat" });
  });

  it("rejects a seat occupied by someone else", () => {
    const result = resolveSeatClaim(seat, { x: 100, y: 100 }, "u2", "u1", null);
    expect(result).toEqual({ accepted: false, reason: "occupied" });
  });

  it("accepts re-claiming the seat you already occupy", () => {
    const result = resolveSeatClaim(seat, { x: 100, y: 100 }, "u1", "u1", "desk-1-a");
    expect(result).toEqual({ accepted: true, seatId: "desk-1-a", previousSeatId: null });
  });

  it("rejects a claim from outside the radius", () => {
    const farAway = { x: 100, y: 100 + 121 };
    const result = resolveSeatClaim(seat, farAway, undefined, "u1", null);
    expect(result).toEqual({ accepted: false, reason: "out_of_range" });
  });

  it("accepts a claim exactly at the radius boundary", () => {
    const atRadius = { x: 100, y: 100 + 120 };
    const result = resolveSeatClaim(seat, atRadius, undefined, "u1", null);
    expect(result.accepted).toBe(true);
  });

  it("accepts a fresh claim with no previous seat", () => {
    const result = resolveSeatClaim(seat, { x: 105, y: 95 }, undefined, "u1", null);
    expect(result).toEqual({ accepted: true, seatId: "desk-1-a", previousSeatId: null });
  });

  it("accepts a claim on a new seat and reports the previous seat to release", () => {
    const result = resolveSeatClaim(seat, { x: 105, y: 95 }, undefined, "u1", "desk-2-a");
    expect(result).toEqual({ accepted: true, seatId: "desk-1-a", previousSeatId: "desk-2-a" });
  });

  it("first-writer-wins: the second of two simultaneous claims for the same seat is rejected", () => {
    // Simulates RoomManager's synchronous check-and-set: the caller updates
    // occupancy between calls, so the second resolveSeatClaim call already
    // observes the first's result — there is no window for both to succeed.
    let occupiedBy: string | undefined;

    const first = resolveSeatClaim(seat, { x: 100, y: 100 }, occupiedBy, "u1", null);
    expect(first.accepted).toBe(true);
    occupiedBy = "u1";

    const second = resolveSeatClaim(seat, { x: 100, y: 100 }, occupiedBy, "u2", null);
    expect(second).toEqual({ accepted: false, reason: "occupied" });
  });

  it("respects a custom radius", () => {
    const result = resolveSeatClaim(seat, { x: 100, y: 150 }, undefined, "u1", null, 40);
    expect(result).toEqual({ accepted: false, reason: "out_of_range" });
  });
});
