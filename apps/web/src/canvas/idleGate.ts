/**
 * Lets the room screen's drawing loop REST when nothing is changing, and wakes it the instant anything might
 * need drawing. Before this, the loop asked the browser for a new frame on every screen refresh, all the time,
 * even with nobody moving, which keeps the processor busy and drains a laptop's battery for no reason
 * (docs/architecture/company-map-builder.md, step D and decision D13).
 *
 *   frame ─► did anything change or still need to change?
 *              yes ─► keep going
 *              no, for QUIET_FRAMES_BEFORE_STOP frames in a row ─► stop asking the browser for frames
 *
 *   something happens (a key, a click, a drag, the wheel, a resized window, a person moving, a seat taken) ─► wake()
 *
 * No timers: a resting loop asks the browser for nothing at all. Wake-ups come from events the browser already
 * delivers, so nothing here needs to be polled.
 */

/** The part of Pixi's ticker this needs; anything with these three members works (and tests use a fake). */
export interface TickerLike {
  readonly started: boolean;
  start(): void;
  stop(): void;
}

/**
 * Treats several clocks as one, so they rest and wake together. Pixi keeps a small internal clock of its own (it runs
 * its memory clean-up chores on it) that would otherwise keep asking the browser for a frame 60 times a second even
 * when the room's own loop is resting. The first clock decides whether the group counts as running.
 */
export function tickerGroup(primary: TickerLike, ...others: Pick<TickerLike, "start" | "stop">[]): TickerLike {
  return {
    get started() {
      return primary.started;
    },
    start() {
      primary.start();
      for (const other of others) other.start();
    },
    stop() {
      primary.stop();
      for (const other of others) other.stop();
    },
  };
}

/** A few frames of margin after the last change, so a late redraw (a resize, a text label) is never cut off. */
export const QUIET_FRAMES_BEFORE_STOP = 5;

export class IdleGate {
  private quietFrames = 0;

  constructor(
    private readonly ticker: TickerLike,
    private readonly quietFramesBeforeStop: number = QUIET_FRAMES_BEFORE_STOP,
  ) {}

  /** Something changed, or might need drawing: make sure frames are being drawn. Safe to call as often as you like. */
  wake(): void {
    this.quietFrames = 0;
    if (!this.ticker.started) this.ticker.start();
  }

  /** Call once at the end of every frame. `busy` is true while anything is still changing. */
  frameDone(busy: boolean): void {
    if (busy) {
      this.quietFrames = 0;
      return;
    }
    this.quietFrames += 1;
    if (this.quietFrames >= this.quietFramesBeforeStop) this.ticker.stop();
  }
}

/**
 * Wakes the gate on everything a person can do to the screen, and on the tab coming back. Mouse movement over the
 * page does NOT wake it (only dragging does), so a mouse resting on the page costs nothing. Returns a function that
 * removes every listener it added.
 */
export function wakeOnActivity(
  gate: { wake(): void },
  targets: { window: EventTarget; canvas: EventTarget; document: EventTarget },
): () => void {
  const wake = () => gate.wake();
  const wakeWhilePressed = (event: Event) => {
    if ((event as PointerEvent).buttons) gate.wake();
  };

  const listeners: [EventTarget, string, EventListener][] = [
    [targets.window, "keydown", wake],
    [targets.window, "keyup", wake],
    [targets.window, "resize", wake],
    [targets.window, "pointerup", wake],
    [targets.window, "pointermove", wakeWhilePressed],
    [targets.canvas, "pointerdown", wake],
    [targets.canvas, "wheel", wake],
    [targets.document, "visibilitychange", wake],
  ];
  for (const [target, type, listener] of listeners) target.addEventListener(type, listener);
  return () => {
    for (const [target, type, listener] of listeners) target.removeEventListener(type, listener);
  };
}
