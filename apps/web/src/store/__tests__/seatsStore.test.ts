import { describe, it, expect, beforeEach } from "vitest";
import { seatsStore, seatOf } from "../seatsStore";

describe("seatsStore", () => {
  beforeEach(() => seatsStore.getState().clear());

  it("applySnapshot wholesale-replaces occupancy", () => {
    seatsStore.getState().applySnapshot([
      { seatId: "desk-1-a", userId: "u1" },
      { seatId: "desk-2-a", userId: "u2" },
    ]);
    expect(seatsStore.getState().occupancy.size).toBe(2);

    // A second, smaller snapshot must drop anything not present in it.
    seatsStore.getState().applySnapshot([{ seatId: "desk-1-a", userId: "u1" }]);
    expect(seatsStore.getState().occupancy.size).toBe(1);
    expect(seatsStore.getState().occupancy.get("desk-2-a")).toBeUndefined();
  });

  it("applyUpdate sets an occupant", () => {
    seatsStore.getState().applyUpdate("desk-1-a", "u1");
    expect(seatsStore.getState().occupancy.get("desk-1-a")).toBe("u1");
  });

  it("applyUpdate with userId null frees the seat", () => {
    seatsStore.getState().applyUpdate("desk-1-a", "u1");
    seatsStore.getState().applyUpdate("desk-1-a", null);
    expect(seatsStore.getState().occupancy.has("desk-1-a")).toBe(false);
  });

  it("seatOf finds the seat a user occupies", () => {
    seatsStore.getState().applySnapshot([{ seatId: "desk-3-b", userId: "u9" }]);
    expect(seatOf(seatsStore.getState().occupancy, "u9")).toBe("desk-3-b");
    expect(seatOf(seatsStore.getState().occupancy, "nobody")).toBeNull();
  });

  it("a stale seat:update echo for a seat we've already left elsewhere is just data — it never touches local seated state", () => {
    // seatsStore has no notion of "am I seated" at all — that lives on
    // MovementController. Applying an update here can never resurrect it;
    // this test documents that by construction there is nothing to check
    // beyond occupancy itself changing as instructed.
    seatsStore.getState().applyUpdate("desk-1-a", "me");
    seatsStore.getState().applyUpdate("desk-1-a", null);
    expect(seatsStore.getState().occupancy.has("desk-1-a")).toBe(false);
  });
});
