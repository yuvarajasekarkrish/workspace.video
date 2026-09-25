import { describe, it, expect, vi } from "vitest";
import { MovementController } from "../MovementController";

function makeController(initial = { x: 0, y: 0 }) {
  const onLocalPositionChanged = vi.fn();
  const onSendMove = vi.fn();
  const onTeleport = vi.fn();
  const onStandUp = vi.fn();
  const controller = new MovementController(initial, { onLocalPositionChanged, onSendMove, onTeleport, onStandUp });
  return { controller, onLocalPositionChanged, onSendMove, onTeleport, onStandUp };
}

describe("MovementController", () => {
  it("does not call onLocalPositionChanged when there is no input", () => {
    const { controller, onLocalPositionChanged } = makeController();
    controller.update(1 / 60, 1000);
    expect(onLocalPositionChanged).not.toHaveBeenCalled();
  });

  describe("moveTo — instant relocation (click-to-move, walk-to-person, walk-to-zone)", () => {
    it("sets the position immediately, in one step, not over time", () => {
      const { controller, onLocalPositionChanged } = makeController();
      controller.moveTo({ x: 1000, y: 0 }, 1000);

      expect(onLocalPositionChanged).toHaveBeenCalledTimes(1);
      expect(onLocalPositionChanged).toHaveBeenCalledWith({ x: 1000, y: 0 });
    });

    it("fires onTeleport once, immediately — never the throttled onSendMove path", () => {
      const { controller, onTeleport, onSendMove } = makeController();
      controller.moveTo({ x: 1000, y: 0 }, 1000);

      expect(onTeleport).toHaveBeenCalledTimes(1);
      expect(onTeleport).toHaveBeenCalledWith({ x: 1000, y: 0 });
      expect(onSendMove).not.toHaveBeenCalled();
    });

    it("a subsequent update() with no keys held does not move further — nothing left to step", () => {
      const { controller, onLocalPositionChanged } = makeController();
      controller.moveTo({ x: 1000, y: 0 }, 1000);
      onLocalPositionChanged.mockClear();

      controller.update(1 / 60, 1016);
      expect(onLocalPositionChanged).not.toHaveBeenCalled();
    });

    it("clamps an out-of-room target to the configured bounds", () => {
      const bounds = { roomWidthPx: 500, roomHeightPx: 500, maxSpeedPxPerSec: 2000, clientThrottleMs: 50, maxBurstMs: 200 };
      const onLocalPositionChanged = vi.fn();
      const controller = new MovementController({ x: 0, y: 0 }, { onLocalPositionChanged, onSendMove: vi.fn(), onTeleport: vi.fn() }, bounds);

      controller.moveTo({ x: 10_000, y: -500 }, 1000);

      expect(onLocalPositionChanged).toHaveBeenCalledWith({ x: 500, y: 0 });
    });

    it("stands the user up if they were seated, then relocates", () => {
      const { controller, onStandUp } = makeController();
      controller.applyTeleport({ x: 10, y: 10 });

      controller.moveTo({ x: 500, y: 10 }, 1000);

      expect(controller.isSeated()).toBe(false);
      expect(onStandUp).toHaveBeenCalledTimes(1);
    });
  });

  it("a correction snaps position directly", () => {
    const { controller, onLocalPositionChanged } = makeController();
    controller.moveTo({ x: 1000, y: 0 }, 1000);
    onLocalPositionChanged.mockClear();

    controller.applyCorrection({ x: 42, y: 42 });
    expect(onLocalPositionChanged).toHaveBeenCalledWith({ x: 42, y: 42 });

    onLocalPositionChanged.mockClear();
    controller.update(1 / 60, 2000);
    expect(onLocalPositionChanged).not.toHaveBeenCalled();
  });

  describe("seating", () => {
    it("applyTeleport marks the controller seated, snaps position, and clears held state", () => {
      const { controller, onLocalPositionChanged } = makeController();
      controller.moveTo({ x: 1000, y: 0 }, 1000);

      controller.applyTeleport({ x: 42, y: 42 });

      expect(controller.isSeated()).toBe(true);
      expect(onLocalPositionChanged).toHaveBeenCalledWith({ x: 42, y: 42 });

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

  it("is false right after moveTo — nothing left to step, unlike the old click-to-walk", () => {
    const { controller } = makeController();
    controller.moveTo({ x: 300, y: 0 }, 1000);
    expect(controller.needsFrames()).toBe(false);
  });

  it("is false while seated, even right after sitting down", () => {
    const { controller } = makeController();
    controller.moveTo({ x: 300, y: 0 }, 1000);
    controller.applyTeleport({ x: 500, y: 500 });
    expect(controller.needsFrames()).toBe(false);
  });

  it("is true after the server corrects the position, until the corrected position has been sent", () => {
    const { controller } = makeController();
    controller.moveTo({ x: 300, y: 0 }, 1000); // relocated and sent via onTeleport
    controller.applyCorrection({ x: 5, y: 5 });
    expect(controller.needsFrames()).toBe(true);
    controller.update(0.1, 1200);
    expect(controller.needsFrames()).toBe(false); // the corrected position went out, so no more frames are needed
  });
});
