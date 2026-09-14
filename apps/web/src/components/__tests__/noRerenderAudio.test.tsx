import { describe, it, expect, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";
import { useRef } from "react";
import { proximityStore } from "@/store/proximityStore";
import { useMediaStore } from "@/store/mediaStore";

/**
 * Executable form of the hard rule extended to audio: proximityStore can
 * update at up to 10Hz (proximity:update fires every server tick while a
 * peer's distance is continuously changing — see spatialAudio.ts's module
 * docs), and it is read only by SpatialAudioController via getState()/
 * subscribe(), never by a React component. This mounts a component the way
 * an audio status indicator would be (via useMediaStore, the one audio
 * store React may subscribe to), pushes ~100 proximity updates through
 * proximityStore, and asserts the component never re-renders — because it
 * isn't subscribed to proximityStore at all. Mirrors
 * components/__tests__/noRerender.test.tsx for the position case.
 */
function MicStatusIndicator({ onRender }: { onRender: (count: number) => void }) {
  const micEnabled = useMediaStore((s) => s.micEnabled);
  const renderCount = useRef(0);
  renderCount.current += 1;
  onRender(renderCount.current);
  return <div data-testid="mic-status">{micEnabled ? "on" : "off"}</div>;
}

describe("no re-render on proximity/gain updates", () => {
  beforeEach(() => proximityStore.getState().clear());

  it("does not re-render a mediaStore-subscribed component when 100 proximity updates are applied", () => {
    let latestRenderCount = 0;
    render(<MicStatusIndicator onRender={(c) => (latestRenderCount = c)} />);
    const renderCountAfterMount = latestRenderCount;
    expect(renderCountAfterMount).toBeGreaterThan(0);

    // Simulate ~100 proximity:update ticks for a peer walking through the
    // 200-500px band, where gain changes continuously every tick.
    act(() => {
      for (let i = 0; i < 100; i++) {
        proximityStore.getState().setPeerProximity("u1", {
          audioSubscribed: true,
          audioGain: i / 100,
        });
      }
    });

    expect(latestRenderCount).toBe(renderCountAfterMount);
  });
});
