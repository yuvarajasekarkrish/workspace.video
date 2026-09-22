import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { RoomDock, filterRoster, filterZones } from "../RoomDock";
import { ZoomControls } from "../ZoomControls";
import { mediaStore } from "@/store/mediaStore";
import { peersStore } from "@/store/peersStore";

// The bar under the map: one line of icon-only buttons. What works today (microphone, find people, leave) is
// tested for what a person sees and can do; what does not exist yet (camera, screen share, emoji, status, invite)
// must be visibly switched off rather than silently doing nothing.

afterEach(() => {
  cleanup();
  mediaStore.getState().reset();
  peersStore.getState().clear();
});

function props() {
  return { onEnableAudio: vi.fn(), onToggleMute: vi.fn(), onGoToPerson: vi.fn(), onGoToArea: vi.fn(), zones: [] };
}

function seedPeople() {
  act(() => {
    peersStore.getState().applySnapshot("me", [
      { userId: "me", name: "Me Myself", avatarUrl: null, position: { x: 100, y: 100 } },
      { userId: "u2", name: "Asha Rao", avatarUrl: null, position: { x: 900, y: 400 } },
      { userId: "u3", name: "Ben Ortiz", avatarUrl: null, position: { x: 1500, y: 700 } },
    ]);
  });
}

describe("the bar", () => {
  it("is one toolbar holding every control, in one row", () => {
    render(<RoomDock {...props()} />);
    const bar = screen.getByRole("toolbar", { name: "Room controls" });
    expect(bar.className).toContain("flex-nowrap");
    const names = Array.from(bar.querySelectorAll("button, a")).map((el) => el.getAttribute("aria-label"));
    expect(names).toEqual([
      "Microphone (connecting)",
      "Camera (coming soon)",
      "Share screen (coming soon)",
      "Find people",
      "Areas",
      "Emoji (coming soon)",
      "Set status (coming soon)",
      "Invite to talk (coming soon)",
      "Leave room",
    ]);
  });

  it("switches off the things that are not built yet, so they cannot be clicked", () => {
    render(<RoomDock {...props()} />);
    for (const name of ["Camera (coming soon)", "Share screen (coming soon)", "Emoji (coming soon)", "Set status (coming soon)", "Invite to talk (coming soon)"]) {
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    }
  });

  it("leaves the room by going back to the home page", () => {
    render(<RoomDock {...props()} />);
    expect(screen.getByRole("link", { name: "Leave room" }).getAttribute("href")).toBe("/");
  });
});

describe("the microphone button", () => {
  it("cannot be used while audio is still connecting", () => {
    render(<RoomDock {...props()} />);
    expect((screen.getByRole("button", { name: "Microphone (connecting)" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("asks to turn the microphone on the first time, from a real click", () => {
    const p = props();
    act(() => mediaStore.getState().setStatus("connected"));
    render(<RoomDock {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Turn on microphone" }));
    expect(p.onEnableAudio).toHaveBeenCalledTimes(1);
    expect(p.onToggleMute).not.toHaveBeenCalled();
  });

  it("asks to click again to hear everyone when the browser is blocking playback", () => {
    const p = props();
    act(() => {
      mediaStore.getState().setStatus("connected");
      mediaStore.getState().setMicEnabled(true);
    });
    render(<RoomDock {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Click to hear everyone" }));
    expect(p.onEnableAudio).toHaveBeenCalledTimes(1);
  });

  it("mutes and unmutes once audio is on, and the label says what the next click does", () => {
    const p = props();
    act(() => {
      mediaStore.getState().setStatus("connected");
      mediaStore.getState().setMicEnabled(true);
      mediaStore.getState().setCanPlaybackAudio(true);
    });
    render(<RoomDock {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Mute microphone" }));
    expect(p.onToggleMute).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Unmute microphone" }));
    expect(p.onToggleMute).toHaveBeenLastCalledWith(false);
    expect(p.onEnableAudio).not.toHaveBeenCalled();
  });

  it("shows why audio failed", () => {
    act(() => {
      mediaStore.getState().setStatus("error");
      mediaStore.getState().setError("room connection has timed out");
    });
    render(<RoomDock {...props()} />);
    expect(screen.getByText("Audio: room connection has timed out")).toBeTruthy();
  });
});

describe("finding people", () => {
  it("opens a list of everyone in the room, with the person themselves marked", () => {
    seedPeople();
    render(<RoomDock {...props()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Find people" }));
    const list = screen.getByRole("list", { name: "People in this room" });
    expect(list.textContent).toContain("Asha Rao");
    expect(list.textContent).toContain("Ben Ortiz");
    expect(list.textContent).toContain("Me Myself");
    expect((screen.getByRole("button", { name: /Me Myself/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("narrows the list as the person types, and says so when nobody matches", () => {
    seedPeople();
    render(<RoomDock {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Find people" }));
    const box = screen.getByRole("searchbox", { name: "Find a person" });
    fireEvent.change(box, { target: { value: "ben" } });
    const list = screen.getByRole("list", { name: "People in this room" });
    expect(list.textContent).toContain("Ben Ortiz");
    expect(list.textContent).not.toContain("Asha Rao");
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("No one matches.")).toBeTruthy();
  });

  it("walks to the chosen person and closes the list", () => {
    seedPeople();
    const p = props();
    render(<RoomDock {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Find people" }));
    fireEvent.click(screen.getByRole("button", { name: "Asha Rao" }));
    expect(p.onGoToPerson).toHaveBeenCalledWith("u2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes with Escape without walking anywhere", () => {
    seedPeople();
    const p = props();
    render(<RoomDock {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Find people" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(p.onGoToPerson).not.toHaveBeenCalled();
  });

  it("closes when the person clicks somewhere else", () => {
    seedPeople();
    render(<RoomDock {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Find people" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("says nobody else is here when the person is alone", () => {
    act(() => {
      peersStore.getState().applySnapshot("me", [{ userId: "me", name: "Me Myself", avatarUrl: null, position: { x: 1, y: 1 } }]);
    });
    render(<RoomDock {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "Find people" }));
    fireEvent.change(screen.getByRole("searchbox", { name: "Find a person" }), { target: { value: "x" } });
    expect(screen.getByText("No one else is here yet.")).toBeTruthy();
  });
});

const AREAS = [
  { id: "z1", label: "Focus Pods", kind: "focus", rect: { col: 0, row: 0, cols: 4, rows: 4 }, capacity: 14 },
  { id: "z2", label: "Boardroom", kind: "meeting", rect: { col: 4, row: 0, cols: 6, rows: 6 } },
] as const;

// The areas list (2026-09-26): replaces drawing area names on the map itself, since tilted text at
// that size never read as crisp as flat text — same shape and behaviour as "finding people" above.
describe("the areas list", () => {
  it("opens a list of the room's areas, with capacity shown when the area has one", () => {
    render(<RoomDock {...props()} zones={[...AREAS]} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Areas" }));
    const list = screen.getByRole("list", { name: "Areas in this room" });
    expect(list.textContent).toContain("Focus Pods");
    expect(list.textContent).toContain("/14");
    expect(list.textContent).toContain("Boardroom");
  });

  it("narrows the list as the person types, and says so when nothing matches", () => {
    render(<RoomDock {...props()} zones={[...AREAS]} />);
    fireEvent.click(screen.getByRole("button", { name: "Areas" }));
    const box = screen.getByRole("searchbox", { name: "Find an area" });
    fireEvent.change(box, { target: { value: "board" } });
    const list = screen.getByRole("list", { name: "Areas in this room" });
    expect(list.textContent).toContain("Boardroom");
    expect(list.textContent).not.toContain("Focus Pods");
    fireEvent.change(box, { target: { value: "zzz" } });
    expect(screen.getByText("No area matches.")).toBeTruthy();
  });

  it("walks to the chosen area and closes the list", () => {
    const p = props();
    render(<RoomDock {...p} zones={[...AREAS]} />);
    fireEvent.click(screen.getByRole("button", { name: "Areas" }));
    fireEvent.click(screen.getByRole("button", { name: "Boardroom" }));
    expect(p.onGoToArea).toHaveBeenCalledWith("z2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes with Escape without walking anywhere", () => {
    const p = props();
    render(<RoomDock {...p} zones={[...AREAS]} />);
    fireEvent.click(screen.getByRole("button", { name: "Areas" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(p.onGoToArea).not.toHaveBeenCalled();
  });

  it("closes when the person clicks somewhere else", () => {
    render(<RoomDock {...props()} zones={[...AREAS]} />);
    fireEvent.click(screen.getByRole("button", { name: "Areas" }));
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("filterZones", () => {
  it("matches by name, ignoring case, and returns every area for an empty query", () => {
    const zones = [...AREAS];
    expect(filterZones(zones, "board").map((z) => z.id)).toEqual(["z2"]);
    expect(filterZones(zones, "FOCUS").map((z) => z.id)).toEqual(["z1"]);
    expect(filterZones(zones, "")).toEqual(zones);
    expect(filterZones(zones, "zzz")).toEqual([]);
  });
});

describe("filterRoster", () => {
  const roster = [
    { userId: "a", name: "Asha Rao", avatarUrl: null, isLocal: false },
    { userId: "b", name: "Ben Ortiz", avatarUrl: null, isLocal: false },
  ];
  it("ignores capital letters and stray spaces, and returns everyone for an empty search", () => {
    expect(filterRoster(roster, "  ASHA ").map((p) => p.userId)).toEqual(["a"]);
    expect(filterRoster(roster, "").map((p) => p.userId)).toEqual(["a", "b"]);
  });
});

describe("the zoom buttons", () => {
  it("call zoom in, zoom out and fit", () => {
    const onZoomIn = vi.fn();
    const onZoomOut = vi.fn();
    const onFit = vi.fn();
    render(<ZoomControls onZoomIn={onZoomIn} onZoomOut={onZoomOut} onFit={onFit} />);
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    fireEvent.click(screen.getByRole("button", { name: "Zoom out" }));
    fireEvent.click(screen.getByRole("button", { name: "Fit whole map" }));
    expect(onZoomIn).toHaveBeenCalledTimes(1);
    expect(onZoomOut).toHaveBeenCalledTimes(1);
    expect(onFit).toHaveBeenCalledTimes(1);
  });
});
