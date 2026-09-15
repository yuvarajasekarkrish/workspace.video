import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { zoneStore } from "@/store/zoneStore";
import { ZoneToast } from "../ZoneToast";

describe("ZoneToast", () => {
  afterEach(() => {
    cleanup();
    zoneStore.getState().clear();
  });

  it("shows nothing on mount, even if already inside a zone (e.g. spawn point)", () => {
    zoneStore.getState().setZone({ id: "lounge", label: "Lounge", kind: "open" });
    const { container } = render(<ZoneToast />);
    expect(container.innerHTML).toBe("");
  });

  it("announces joining a meeting room with the audio effect, after the initial spawn zone", () => {
    render(<ZoneToast />);

    act(() => {
      zoneStore.getState().setZone({ id: "meet-a", label: "Meeting Room A", kind: "meeting" });
    });

    expect(screen.getByText("Joined Meeting Room A")).toBeTruthy();
    expect(screen.getByText("People outside can't hear you.")).toBeTruthy();
  });

  it("announces leaving a zone by name", () => {
    render(<ZoneToast />);
    act(() => {
      zoneStore.getState().setZone({ id: "meet-a", label: "Meeting Room A", kind: "meeting" });
    });

    act(() => {
      zoneStore.getState().setZone(null);
    });

    expect(screen.getByText("Left Meeting Room A")).toBeTruthy();
    expect(screen.getByText("Back to nearby audio.")).toBeTruthy();
  });

  it("gives focus zones a do-not-disturb message", () => {
    render(<ZoneToast />);
    act(() => {
      zoneStore.getState().setZone({ id: "focus-1", label: "Focus Area", kind: "focus" });
    });

    expect(screen.getByText("Your audio is paused here.")).toBeTruthy();
  });
});
