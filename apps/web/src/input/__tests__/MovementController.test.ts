import { describe, it, expect, vi } from "vitest";
import { MovementController } from "../MovementController";

function makeController(initial = { x: 0, y: 0 }) {
  const onLocalPositionChanged = vi.fn();
  const onSendMove = vi.fn();
  const onStandUp = vi.fn();
  const controller = new MovementController(initial, { onLocalPositionChanged, onSendMove, onStandUp });
  return { controller, onLocalPositionChanged, onSendMove, onStandUp };
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

  describe("seating", () => {
    it("applyTeleport marks the controller seated, snaps position, and clears held state", () => {
      const { controller, onLocalPositionChanged } = makeController();
      controller.setWalkTarget({ x: 1000, y: 0 }); // an in-flight walk target...

      controller.applyTeleport({ x: 42, y: 42 });

      expect(controller.isSeated()).toBe(true);
      expect(onLocalPositionChanged).toHaveBeenCalledWith({ x: 42, y: 42 });

      // ...that must not resume once seated (walkTarget cleared).
      onLocalPositionChanged.mockClear();
      controller.update(1 / 60, 1000);
      expect(onLocalPositionChanged).not.toHaveBeenCalled();
    });

    it("update() is a total no-op while seated — no movement, no send", () => {
      const { controller, onLocalPositionChanged, onSendMove } = makeController();
      controller.applyTeleport({ x: 10, y: 10 });
      onLocalPositionChanged.mockClear(); // applyTeleport itself calls this once, for the teleport

      controller.update(1 / 60, 1000);
      controller.update(1 / 60, 1016);
      controller.update(1 / 60, 1032);

      expect(onLocalPositionChanged).not.toHaveBeenCalled();
      expect(onSendMove).not.toHaveBeenCalled();
    });

    it("a movement keydown stands the user up on the same frame, with no round trip", () => {
      const { controller, onStandUp, onLocalPositionChanged } = makeController();
      controller.applyTeleport({ x: 10, y: 10 });
      onLocalPositionChanged.mockClear(); // applyTeleport itself calls this once, for the teleport

      const target = new EventTarget();
      const detach = controller.attachKeyboard(target);
      target.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));

      // Stood up immediately — before any server round trip could occur.
      expect(controller.isSeated()).toBe(false);
      expect(onStandUp).toHaveBeenCalledTimes(1);

      // And movement resumes THIS frame: update() now advances position
      // from the held key, with no wait on a seat:release ack.
      controller.update(1 / 60, 1000);
      expect(onLocalPositionChanged).toHaveBeenCalled();
      const [pos] = onLocalPositionChanged.mock.calls[0]!;
      expect(pos.x).toBeGreaterThan(10);

      detach();
    });

    it("a click-to-walk target also stands the user up", () => {
      const { controller, onStandUp } = makeController();
      controller.applyTeleport({ x: 10, y: 10 });

      controller.setWalkTarget({ x: 500, y: 10 });

      expect(controller.isSeated()).toBe(false);
      expect(onStandUp).toHaveBeenCalledTimes(1);
    });

    it("standing up is idempotent — onStandUp fires only once even with repeated input", () => {
      const { controller, onStandUp } = makeController();
      controller.applyTeleport({ x: 10, y: 10 });

      const target = new EventTarget();
      const detach = controller.attachKeyboard(target);
      target.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyD" }));
      target.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW" }));

      expect(onStandUp).toHaveBeenCalledTimes(1);
      detach();
    });

    it("applyCorrection while seated does NOT stand the user up", () => {
      const { controller, onStandUp } = makeController();
      controller.applyTeleport({ x: 10, y: 10 });

      controller.applyCorrection({ x: 11, y: 11 });

      expect(controller.isSeated()).toBe(true);
      expect(onStandUp).not.toHaveBeenCalled();

      // And movement is still suppressed — a correction must never be
      // mistaken for a stand-up input.
      controller.update(1 / 60, 1000);
      expect(controller.isSeated()).toBe(true);
    });
  });
});

describe("MovementController.needsFrames: does the screen still have to draw for this person?", () => {
  const keyboard = () => {
    const { controller, onSendMove } = makeController();
    const target = new EventTarget();
    controller.attachKeyboard(target);
    const press = (code: string) => target.dispatchEvent(Object.assign(new Event("keydown"), { code }));
    const release = (code: string) => target.dispatchEvent(Object.assign(new Event("keyup"), { code }));
    return { controller, onSendMove, press, release };
  };

  it("is false when nobody is doing anything", () => {
    expect(makeController().controller.needsFrames()).toBe(false);
  });

  it("is true while a movement key is held, and false once it is released and the last position has been sent", () => {
    const { controller, press, release } = keyboard();
    press("KeyD");
    expect(controller.needsFrames()).toBe(true);
    controller.update(1 / 60, 1000); // moves and sends at once
    release("KeyD");
    expect(controller.needsFrames()).toBe(false);
  });

  it("stays true after a key is released if the newest position has not been sent yet, until it is", () => {
    const { controller, onSendMove, press, release } = keyboard();
    press("KeyD");
    controller.update(1 / 60, 1000); // sent
    controller.update(1 / 60, 1010); // moved again, too soon to send
    release("KeyD");
    expect(onSendMove).toHaveBeenCalledTimes(1);
    expect(controller.needsFrames()).toBe(true);
    controller.update(1 / 60, 1100); // the throttle has passed: the last position is sent
    expect(onSendMove).toHaveBeenCalledTimes(2);
    expect(controller.needsFrames()).toBe(false);
  });

  it("is true while walking to a clicked spot, and false once there", () => {
    const { controller } = makeController();
    controller.setWalkTarget({ x: 300, y: 0 });
    expect(controller.needsFrames()).toBe(true);
    let now = 1000;
    for (let i = 0; i < 1000 && controller.needsFrames(); i++) controller.update(0.1, (now += 100));
    expect(controller.needsFrames()).toBe(false);
  });

  it("is false while seated, even right after sitting down", () => {
    const { controller } = makeController();
    controller.setWalkTarget({ x: 300, y: 0 });
    controller.update(0.1, 1000);
    controller.applyTeleport({ x: 500, y: 500 });
    expect(controller.needsFrames()).toBe(false);
  });

  it("is true after the server corrects the position, until the corrected position has been sent", () => {
    const { controller } = makeController();
    controller.setWalkTarget({ x: 300, y: 0 });
    controller.update(0.1, 1000); // moved and sent
    controller.applyCorrection({ x: 5, y: 5 });
    expect(controller.needsFrames()).toBe(true);
    controller.update(0.1, 1200);
    expect(controller.needsFrames()).toBe(false); // the corrected position went out, so no more frames are needed
  });
});
