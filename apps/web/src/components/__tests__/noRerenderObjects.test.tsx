import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useRef } from "react";
import { objectsStore, useSelectedObject } from "@/store/objectsStore";
import type { ObjectState } from "@workspace-video/shared";

/**
 * Executable form of the hard rule, extended to objects: a component
 * subscribed via useSelectedObject() must not re-render across a drag's
 * worth of applyLocalEdit calls, but must re-render when the selection
 * actually changes. Mirrors components/__tests__/noRerender.test.tsx
 * (peers) and noRerenderAudio.test.tsx (proximity/gain).
 */
function SelectionWatcher({ onRender }: { onRender: (count: number) => void }) {
  const selected = useSelectedObject("local-user");
  const renderCount = useRef(0);
  renderCount.current += 1;
  onRender(renderCount.current);
  return <div data-testid="selected">{selected?.objectId ?? "none"}</div>;
}

function makeObject(overrides: Partial<ObjectState> = {}): ObjectState {
  return {
    objectId: "obj1",
    roomId: "room1",
    type: "note",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    z: 0,
    data: {},
    version: 1,
    createdById: "local-user",
    ...overrides,
  };
}

describe("no re-render on object drag", () => {
  beforeEach(() => objectsStore.getState().clear());

  it("does not re-render when 100 drag updates are applied to the selected object", () => {
    objectsStore.getState().applySnapshot([makeObject()]);
    objectsStore.getState().setSelected("obj1");

    let latestRenderCount = 0;
    render(<SelectionWatcher onRender={(c) => (latestRenderCount = c)} />);
    const renderCountAfterMount = latestRenderCount;
    expect(renderCountAfterMount).toBeGreaterThan(0);

    // Simulate ~100 drag-frame updates (the exact traffic pattern a
    // pointermove-driven drag produces) — position changes every frame,
    // identity (which object is selected, its type, its creator) never does.
    act(() => {
      for (let i = 0; i < 100; i++) {
        objectsStore.getState().applyLocalEdit("obj1", { x: i, y: i, width: 100, height: 100 });
      }
    });

    expect(latestRenderCount).toBe(renderCountAfterMount);
  });

  it("DOES re-render when the selection actually changes (sanity check on the harness itself)", () => {
    objectsStore.getState().applySnapshot([
      makeObject({ objectId: "obj1" }),
      makeObject({ objectId: "obj2" }),
    ]);
    objectsStore.getState().setSelected("obj1");

    let latestRenderCount = 0;
    render(<SelectionWatcher onRender={(c) => (latestRenderCount = c)} />);
    const renderCountAfterMount = latestRenderCount;

    act(() => {
      objectsStore.getState().setSelected("obj2");
    });

    expect(latestRenderCount).toBeGreaterThan(renderCountAfterMount);
  });
});
