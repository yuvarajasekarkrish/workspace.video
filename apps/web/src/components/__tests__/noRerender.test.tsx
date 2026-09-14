import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useRef } from "react";
import { peersStore, useRoster } from "@/store/peersStore";

/**
 * Executable form of the milestone's hard rule: "React must never
 * re-render on movement." This mounts a component subscribed the same way
 * RoomHud is (via useRoster), pushes ~100 position-only deltas through the
 * store — the exact traffic pattern peers:delta produces at the server's
 * 100ms tick — and asserts the render count does not increase. Without a
 * test like this, the rule can silently rot the next time someone touches
 * peersStore or a component that reads it.
 */
function RenderCounter({ onRender }: { onRender: (count: number) => void }) {
  const roster = useRoster();
  const renderCount = useRef(0);
  renderCount.current += 1;
  onRender(renderCount.current);
  return <div data-testid="roster-count">{roster.length}</div>;
}

describe("no re-render on movement", () => {
  beforeEach(() => peersStore.getState().clear());

  it("does not re-render when 100 position-only deltas are applied", () => {
    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
      { userId: "u2", name: "Bo", avatarUrl: null, position: { x: 10, y: 10 } },
    ]);

    let latestRenderCount = 0;
    render(<RenderCounter onRender={(c) => (latestRenderCount = c)} />);

    const renderCountAfterMount = latestRenderCount;
    expect(renderCountAfterMount).toBeGreaterThan(0);

    // Simulate ~100 position-only server ticks (peers:delta traffic) —
    // roster membership never changes, only coordinates. Wrapped in act()
    // because these mutations originate outside React (as they do in
    // production, from RealtimeClient's socket handlers) and must be
    // flushed synchronously for this assertion to observe the result.
    act(() => {
      for (let i = 0; i < 100; i++) {
        peersStore.getState().applyDelta(
          [
            { userId: "u1", position: { x: i, y: i } },
            { userId: "u2", position: { x: 10 + i, y: 10 + i } },
          ],
          [],
        );
      }
    });

    expect(latestRenderCount).toBe(renderCountAfterMount);
  });

  it("DOES re-render when roster membership actually changes (sanity check on the harness itself)", () => {
    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
    ]);

    let latestRenderCount = 0;
    render(<RenderCounter onRender={(c) => (latestRenderCount = c)} />);
    const renderCountAfterMount = latestRenderCount;

    act(() => {
      peersStore.getState().applySnapshot("u1", [
        { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
        { userId: "u2", name: "Bo", avatarUrl: null, position: { x: 5, y: 5 } },
      ]);
    });

    expect(latestRenderCount).toBeGreaterThan(renderCountAfterMount);
  });
});
