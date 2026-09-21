import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, act } from "@testing-library/react";
import { SPATIAL_MAP_DEFAULT_ZONES, validateRoomMap } from "@workspace-video/shared";
import { ZoneHudChip } from "../ZoneHudChip";
import { zoneStore } from "@/store/zoneStore";
import { peersStore } from "@/store/peersStore";

// The chip gets the room's layout itself, not a name to look up, because a company's own map has no
// name in the built-in list (docs/architecture/company-map-builder.md, D8).

afterEach(() => {
  cleanup();
  zoneStore.getState().clear();
  peersStore.getState().clear();
});

function companyLayout() {
  const result = validateRoomMap({ version: 1, zones: SPATIAL_MAP_DEFAULT_ZONES });
  if (!result.ok) throw new Error(result.errors.join(", "));
  return result.layout;
}

describe("ZoneHudChip with a room's own layout", () => {
  it("shows the area's name, how many people are in it, and its capacity, for a company map", () => {
    const layout = companyLayout();
    act(() => {
      peersStore.getState().applySnapshot("u1", [
        { userId: "u1", name: "a", avatarUrl: null, position: { x: 300, y: 300 } },
        { userId: "u2", name: "b", avatarUrl: null, position: { x: 400, y: 320 } },
        { userId: "u3", name: "c", avatarUrl: null, position: { x: 2300, y: 1100 } },
      ]);
      zoneStore.getState().setZone({ id: "eng-zone", label: "Engineering", kind: "open" });
    });
    render(<ZoneHudChip layout={layout} />);
    expect(screen.getByText("Engineering")).toBeTruthy();
    expect(screen.getByText("2/45")).toBeTruthy();
  });

  it("shows nothing while the person is in no area", () => {
    const { container } = render(<ZoneHudChip layout={companyLayout()} />);
    expect(container.textContent).toBe("");
  });
});
