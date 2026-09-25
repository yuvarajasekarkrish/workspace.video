import type { Point, MovementConfig } from "@workspace-video/shared";
import { DEFAULT_MOVEMENT_CONFIG } from "@workspace-video/shared";
import { integrateKeyboardMove, clampToBounds, shouldEmitMove } from "./movement";

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
  /** Called once, immediately, for a discrete relocation (click-to-move,
   *  walk-to-person, walk-to-zone) — see moveTo's docs. Never throttled the
   *  way onSendMove is: a one-shot event, not a continuous stream. */
  onTeleport: (position: Point) => void;
  /** Called exactly once, locally, the instant the user's own movement
   *  input stands them up out of a seat (a keydown or a click-to-walk).
   *  The caller sends seat:release here — deliberately AFTER `seated` has
   *  already flipped to false and movement has already resumed for this
   *  frame (see applyTeleport's docs and the plan's "stand up is
   *  optimistic" rule): standing up must never wait on a round trip.
   *  Optional so every existing call site is unaffected. */
  onStandUp?: () => void;
}

/**
 * Imperative shell over the shared speed-clamped pure core in movement.ts.
 * Two distinct kinds of input: continuous WASD/arrows (integrated over time,
 * speed-clamped, validated by the server's continuous-speed check) and a
 * discrete relocation — click-to-move, walk-to-person, walk-to-zone — which
 * is instant (moveTo) and validated by the server's separate bounds-only
 * teleport path (RoomManager.teleportTo), never the speed check, since a
 * single deliberate jump has no meaningful "speed" to measure. Holds only
 * the tiny bit of mutable state (current position, held keys, last-sent
 * bookkeeping) that a pure function can't own between ticks.
 */
export class MovementController {
  private position: Point;
  private readonly heldKeys = new Set<string>();
  private lastSentAtMs: number | null = null;
  private lastSentPosition: Point | null = null;
  /** True from an accepted seat claim (applyTeleport) until the user's own
   *  next movement input stands them up. Owned exclusively by this class —
   *  never set from a server seat:update echo (see seatsStore.ts's docs on
   *  this ownership boundary), so a late echo for our own seat can never
   *  resurrect it after we've already stood up locally. */
  private seated = false;

  constructor(
    initialPosition: Point,
    private readonly callbacks: MovementControllerCallbacks,
    /** The room's floor bounds (see @workspace-video/shared's movementConfigForLayout) —
     *  defaults to the global bounds so every existing call site (which
     *  never passed this) is unaffected. Passed through to the same pure
     *  clamping functions the server's validateMove uses, so the local
     *  avatar can never visibly walk past a wall the server would reject. */
    private readonly bounds: MovementConfig = DEFAULT_MOVEMENT_CONFIG,
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
        this.standUp();
        this.heldKeys.add(code);
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

  /** Instantly relocates to `target` — click-to-move, walk-to-person, and
   *  walk-to-zone all call this (via Viewport's onClickToWalk callback and
   *  PixiStage's search-result handlers). Also a stand-up trigger — moving
   *  anywhere while seated stands the user up first (see the class's
   *  `seated` docs). No per-frame stepping: the position is set directly and
   *  sent once via onTeleport, never the throttled per-tick onSendMove path
   *  — see RoomManager.teleportTo, the server's matching discrete-move
   *  validation (bounds only, no continuous-speed check, which has no
   *  meaning for a single deliberate jump). */
  moveTo(target: Point, nowMs: number): void {
    this.standUp();
    const clamped = clampToBounds(target, this.bounds);
    this.position = clamped;
    this.lastSentAtMs = nowMs;
    this.lastSentPosition = clamped;
    this.callbacks.onLocalPositionChanged(clamped);
    this.callbacks.onTeleport(clamped);
  }

  /** True from an accepted seat claim until the user's own next movement
   *  input. Exposed read-only so callers (e.g. the furniture gesture
   *  handler) can decide not to attempt a new claim while already seated. */
  isSeated(): boolean {
    return this.seated;
  }

  /** Snaps directly to `position` and marks the user seated — the
   *  server-sanctioned teleport action for a claimed seat (never routed
   *  through applyCorrection, which must stay indistinguishable from an
   *  ordinary rejection and must NOT stand the user up — see applyCorrection
   *  below). Clears held keys too: a key already down when the claim lands
   *  must not immediately re-trigger standUp() on the very next frame. */
  applyTeleport(position: Point): void {
    this.position = position;
    this.heldKeys.clear();
    this.seated = true;
    this.callbacks.onLocalPositionChanged(position);
  }

  /** Whether the screen still has to keep drawing frames for this person: a movement key is held, or the newest
   *  position has not yet been sent to the server (so the last position is never left unsent when the loop rests).
   *  A click-to-move/walk-to-X no longer needs frames of its own — moveTo relocates and sends in one step. Always
   *  false while seated. Lets the drawing loop rest when nothing is happening. */
  needsFrames(): boolean {
    if (this.seated) return false;
    if (this.heldKeys.size > 0) return true;
    const sent = this.lastSentPosition;
    return sent !== null && (sent.x !== this.position.x || sent.y !== this.position.y);
  }

  /** Called once per Pixi ticker frame with elapsed seconds. While seated,
   *  this is a deliberate no-op — no movement math, no move traffic at all,
   *  which is also what makes many seated occupants nearly free on the
   *  server (see the plan's R2). Otherwise advances local position
   *  immediately (never waiting on the server), and separately decides
   *  whether this tick's position should be sent. Only handles keyboard
   *  input now — click-to-move/walk-to-X are instant, handled entirely by
   *  moveTo, with nothing left to step per frame. */
  update(dtSeconds: number, nowMs: number): void {
    if (this.seated) return;

    const direction = this.currentKeyboardDirection();
    let next = this.position;

    if (direction.x !== 0 || direction.y !== 0) {
      next = integrateKeyboardMove(this.position, direction, dtSeconds, this.bounds);
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

  /** Server rejected our last move (or moveTo/teleport); snap to the
   *  authoritative position. Deliberately does NOT touch `seated` — an
   *  unrelated correction arriving while seated (e.g. a stale in-flight move
   *  from just before the claim) must never be mistaken for a stand-up
   *  input; only local intent (standUp, via keyboard/click) or a fresh
   *  applyTeleport ever changes it. */
  applyCorrection(position: Point): void {
    this.position = position;
    this.callbacks.onLocalPositionChanged(position);
  }

  /** Standing up is optimistic: `seated` flips and movement resumes on the
   *  SAME frame, before any server round trip — the caller's onStandUp
   *  fires after, to send seat:release. A no-op when not seated, so calling
   *  it from every movement-input entry point unconditionally is safe. */
  private standUp(): void {
    if (!this.seated) return;
    this.seated = false;
    this.callbacks.onStandUp?.();
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
