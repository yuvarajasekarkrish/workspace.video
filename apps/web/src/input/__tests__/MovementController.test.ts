import { describe, it, expect, vi } from "vitest";
import { MovementController } from "../MovementController";

function makeController(initial = { x: 0, y: 0 }) {
  const onLocalPositionChanged = vi.fn();
  const onSendMove = vi.fn();
  const controller = new MovementController(initial, { onLocalPositionChanged, onSendMove });
  return { controller, onLocalPositionChanged, onSendMove };
}

describe("MovementController", () => {
  it("sends the first move immediately on any movement", () => {
    const { controller, onSendMove } = makeController();
    controller.setWalkTarget({ x: 100, y: 0 });
    controller.update(1 / 60, 1000);

    expect(onSendMove).toHaveBeenCalledTimes(1);
  });

  it("does not call onLocalPositionChanged when there is no input", () => {
    const { controller, onLocalPositionChanged } = makeController();
    controller.update(1 / 60, 1000);
    expect(onLocalPositionChanged).not.toHaveBeenCalled();
  });

  it("a click-to-walk target moves the position toward it over time", () => {
    const { controller, onLocalPositionChanged } = makeController();
    controller.setWalkTarget({ x: 1000, y: 0 });
    controller.update(1 / 60, 1000);

    const [pos] = onLocalPositionChanged.mock.calls[0]!;
    expect(pos.x).toBeGreaterThan(0);
    expect(pos.y).toBe(0);
  });

  it("respects the client throttle: a second changed-position tick within the interval is not sent", () => {
    const { controller, onSendMove } = makeController();
    controller.setWalkTarget({ x: 1000, y: 0 });

    controller.update(1 / 60, 1000); // sends (first move)
    controller.update(1 / 60, 1010); // 10ms later, position changed again, but under 50ms throttle

    expect(onSendMove).toHaveBeenCalledTimes(1);
  });

  it("sends again once the throttle interval has elapsed and position changed", () => {
    const { controller, onSendMove } = makeController();
    controller.setWalkTarget({ x: 1000, y: 0 });

    controller.update(1 / 60, 1000);
    controller.update(1 / 60, 1060); // 60ms later, past the 50ms throttle

    expect(onSendMove).toHaveBeenCalledTimes(2);
  });

  it("a correction snaps position and clears any in-flight walk target", () => {
    const { controller, onLocalPositionChanged } = makeController();
    controller.setWalkTarget({ x: 1000, y: 0 });
    controller.update(1 / 60, 1000);
    onLocalPositionChanged.mockClear();

    controller.applyCorrection({ x: 42, y: 42 });
    expect(onLocalPositionChanged).toHaveBeenCalledWith({ x: 42, y: 42 });

    // Walk target was cleared, so a subsequent update with no keys held
    // should not move the position further.
    onLocalPositionChanged.mockClear();
    controller.update(1 / 60, 2000);
    expect(onLocalPositionChanged).not.toHaveBeenCalled();
  });
});
