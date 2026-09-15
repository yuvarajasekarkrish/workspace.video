import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useRef } from "react";
import { seatsStore, useSeatOf } from "@/store/seatsStore";

/**
 * The fourth no-rerender guard, matching noRerender.test.tsx (peers),
 * noRerenderAudio.test.tsx (proximity/gain), and noRerenderObjects.test.tsx
 * (drag): a component subscribed via useSeatOf() must not re-render across
 * a batch of occupancy updates for OTHER users, but must re-render when
 * THIS user's own seat identity actually changes.
 */
function MySeatWatcher({ onRender }: { onRender: (count: number) => void }) {
  const seatId = useSeatOf("me");
  const renderCount = useRef(0);
  renderCount.current += 1;
  onRender(renderCount.current);
  return <div data-testid="my-seat">{seatId ?? "standing"}</div>;
}

describe("no re-render on unrelated seat occupancy changes", () => {
  beforeEach(() => seatsStore.getState().clear());

  it("does not re-render when 100 OTHER users' seats change", () => {
    let latestRenderCount = 0;
    render(<MySeatWatcher onRender={(c) => (latestRenderCount = c)} />);
    const renderCountAfterMount = latestRenderCount;
    expect(renderCountAfterMount).toBeGreaterThan(0);

    act(() => {
      for (let i = 0; i < 100; i++) {
        seatsStore.getState().applyUpdate(`desk-${i}-a`, `other-user-${i}`);
      }
    });

    expect(latestRenderCount).toBe(renderCountAfterMount);
  });

  it("DOES re-render when this user's own seat changes (sanity check on the harness itself)", () => {
    let latestRenderCount = 0;
    render(<MySeatWatcher onRender={(c) => (latestRenderCount = c)} />);
    const renderCountAfterMount = latestRenderCount;

    act(() => {
      seatsStore.getState().applyUpdate("desk-1-a", "me");
    });

    expect(latestRenderCount).toBeGreaterThan(renderCountAfterMount);
  });

  it("DOES re-render when this user stands up (their seat goes to null)", () => {
    seatsStore.getState().applyUpdate("desk-1-a", "me");

    let latestRenderCount = 0;
    render(<MySeatWatcher onRender={(c) => (latestRenderCount = c)} />);
    const renderCountAfterMount = latestRenderCount;

    act(() => {
      seatsStore.getState().applyUpdate("desk-1-a", null);
    });

    expect(latestRenderCount).toBeGreaterThan(renderCountAfterMount);
  });
});
