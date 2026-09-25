import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { SeatLabelChip } from "../SeatLabelChip";
import { zoneStore } from "@/store/zoneStore";
import { nearbySeatStore } from "@/store/nearbySeatStore";

// Cosmetic-only hot-desk name popup — independent of the server's zone system
// (see nearbySeatStore.ts's docs). PixiStage's ticker is the real writer of
// nearbySeatStore in production; these tests drive it directly since the
// component itself only ever reads it.

afterEach(() => {
  cleanup();
  zoneStore.getState().clear();
  nearbySeatStore.getState().set(null);
});

describe("SeatLabelChip", () => {
  it("shows nothing when not near a labeled seat", () => {
    const { container } = render(<SeatLabelChip />);
    expect(container.textContent).toBe("");
  });

  it("shows the seat's label when near one", () => {
    act(() => nearbySeatStore.getState().set({ seatId: "floor-desk-1-a", label: "Desk 1" }));
    render(<SeatLabelChip />);
    expect(screen.getByText("Desk 1")).toBeTruthy();
  });

  it("hides itself when a real zone chip is already showing, so the two never stack", () => {
    act(() => {
      nearbySeatStore.getState().set({ seatId: "floor-desk-1-a", label: "Desk 1" });
      zoneStore.getState().setZone({ id: "meet-a-zone", label: "Boardroom", kind: "meeting" });
    });
    const { container } = render(<SeatLabelChip />);
    expect(container.textContent).toBe("");
  });
});
