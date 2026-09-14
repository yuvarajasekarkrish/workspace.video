import type { Point } from "@cosmos/shared";
import {
  integrateKeyboardMove,
  stepTowardWalkTarget,
  shouldEmitMove,
} from "./movement";

const KEY_TO_DIRECTION: Record<string, Point> = {
  KeyW: { x: 0, y: -1 },
  ArrowUp: { x: 0, y: -1 },
  KeyS: { x: 0, y: 1 },
  ArrowDown: { x: 0, y: 1 },
  KeyA: { x: -1, y: 0 },
  ArrowLeft: { x: -1, y: 0 },
  KeyD: { x: 1, y: 0 },
  ArrowRight: { x: 1, y: 0 },
};

export interface MovementControllerCallbacks {
  /** Called immediately whenever the local position changes, so the caller
   *  can update the render position without waiting on the network. */
  onLocalPositionChanged: (position: Point) => void;
  /** Called with a move payload exactly when it should be sent to the
   *  server (already throttled/deduped by movement.ts's shouldEmitMove). */
  onSendMove: (position: Point) => void;
}

/**
 * Imperative shell combining both input modes (WASD/arrows and
 * click-to-walk) over the shared speed-clamped pure core in movement.ts, so
 * neither mode can move faster than the other or outrun the server's speed
 * validator. Holds only the tiny bit of mutable state (current position,
 * held keys, an optional walk target, last-sent bookkeeping) that a pure
 * function can't own between ticks.
 */
export class MovementController {
  private position: Point;
  private readonly heldKeys = new Set<string>();
  private walkTarget: Point | null = null;
  private lastSentAtMs: number | null = null;
  private lastSentPosition: Point | null = null;

  constructor(
    initialPosition: Point,
    private readonly callbacks: MovementControllerCallbacks,
  ) {
    this.position = initialPosition;
  }

  /** `shouldIgnore`, when it returns true, suppresses WASD/arrow handling
   *  entirely for that event — added for Phase 7's note text editor: an
   *  HTML `<textarea>` overlaid on the canvas needs to receive "w"/"a"/"s"/
   *  "d" as ordinary text input, not have them walk the avatar out from
   *  under the user while they're typing. Defaults to never-ignore so every
   *  existing call site (which never passed this) is unaffected. */
  attachKeyboard(target: EventTarget = window, shouldIgnore: () => boolean = () => false): () => void {
    const onKeyDown = (e: Event) => {
      if (shouldIgnore()) return;
      const code = (e as KeyboardEvent).code;
      if (code in KEY_TO_DIRECTION) {
        this.heldKeys.add(code);
        this.walkTarget = null; // keyboard input cancels an in-flight click-to-walk
      }
    };
    const onKeyUp = (e: Event) => {
      this.heldKeys.delete((e as KeyboardEvent).code);
    };

    target.addEventListener("keydown", onKeyDown);
    target.addEventListener("keyup", onKeyUp);
    return () => {
      target.removeEventListener("keydown", onKeyDown);
      target.removeEventListener("keyup", onKeyUp);
    };
  }

  /** Called by Viewport's onClickToWalk callback. */
  setWalkTarget(target: Point): void {
    this.walkTarget = target;
  }

  /** Called once per Pixi ticker frame with elapsed seconds. Advances local
   *  position immediately (never waiting on the server), and separately
   *  decides whether this tick's position should be sent. */
  update(dtSeconds: number, nowMs: number): void {
    const direction = this.currentKeyboardDirection();
    let next = this.position;

    if (direction.x !== 0 || direction.y !== 0) {
      this.walkTarget = null;
      next = integrateKeyboardMove(this.position, direction, dtSeconds);
    } else if (this.walkTarget) {
      next = stepTowardWalkTarget(this.position, this.walkTarget, dtSeconds);
      if (next.x === this.walkTarget.x && next.y === this.walkTarget.y) {
        this.walkTarget = null;
      }
    }

    if (next.x !== this.position.x || next.y !== this.position.y) {
      this.position = next;
      this.callbacks.onLocalPositionChanged(next);
    }

    if (shouldEmitMove(this.lastSentAtMs, this.lastSentPosition, nowMs, this.position)) {
      this.lastSentAtMs = nowMs;
      this.lastSentPosition = this.position;
      this.callbacks.onSendMove(this.position);
    }
  }

  /** Server rejected our last move; snap to the authoritative position and
   *  drop any in-flight walk target so we don't immediately fight it again. */
  applyCorrection(position: Point): void {
    this.position = position;
    this.walkTarget = null;
    this.callbacks.onLocalPositionChanged(position);
  }

  private currentKeyboardDirection(): Point {
    let x = 0;
    let y = 0;
    for (const key of this.heldKeys) {
      const dir = KEY_TO_DIRECTION[key];
      if (dir) {
        x += dir.x;
        y += dir.y;
      }
    }
    return { x, y };
  }
}
