import { describe, it, expect, vi } from "vitest";
import { IdleGate, QUIET_FRAMES_BEFORE_STOP, tickerGroup, wakeOnActivity, type TickerLike } from "../idleGate";

// The room screen used to redraw on every screen refresh, all the time, even with nobody moving. The gate lets the
// drawing loop rest after a few quiet frames and wakes it again the moment anything might need drawing
// (docs/architecture/company-map-builder.md, step D). Nothing here uses a timer: a resting loop asks the
// browser for nothing.

function fakeTicker(started = true): TickerLike & { starts: number; stops: number } {
  const t = {
    started,
    starts: 0,
    stops: 0,
    start() {
      if (!t.started) t.starts++;
      t.started = true;
    },
    stop() {
      if (t.started) t.stops++;
      t.started = false;
    },
  };
  return t;
}

describe("IdleGate", () => {
  it("stops the loop after a few quiet frames in a row, and not before", () => {
    const ticker = fakeTicker();
    const gate = new IdleGate(ticker);
    for (let i = 0; i < QUIET_FRAMES_BEFORE_STOP - 1; i++) gate.frameDone(false);
    expect(ticker.started).toBe(true);
    gate.frameDone(false);
    expect(ticker.started).toBe(false);
    expect(ticker.stops).toBe(1);
  });

  it("keeps running for as long as something is still changing", () => {
    const ticker = fakeTicker();
    const gate = new IdleGate(ticker);
    for (let i = 0; i < 1000; i++) gate.frameDone(true);
    expect(ticker.started).toBe(true);
  });

  it("starts counting quiet frames again from zero after a busy frame", () => {
    const ticker = fakeTicker();
    const gate = new IdleGate(ticker);
    for (let i = 0; i < QUIET_FRAMES_BEFORE_STOP - 1; i++) gate.frameDone(false);
    gate.frameDone(true);
    for (let i = 0; i < QUIET_FRAMES_BEFORE_STOP - 1; i++) gate.frameDone(false);
    expect(ticker.started).toBe(true);
  });

  it("starts a resting loop the moment something might need drawing, and does not start one that is already running", () => {
    const ticker = fakeTicker(false);
    const gate = new IdleGate(ticker);
    gate.wake();
    expect(ticker.started).toBe(true);
    gate.wake();
    gate.wake();
    expect(ticker.starts).toBe(1);
  });

  it("gives a woken loop a full set of quiet frames before it rests again", () => {
    const ticker = fakeTicker();
    const gate = new IdleGate(ticker);
    for (let i = 0; i < QUIET_FRAMES_BEFORE_STOP - 1; i++) gate.frameDone(false);
    gate.wake();
    for (let i = 0; i < QUIET_FRAMES_BEFORE_STOP - 1; i++) gate.frameDone(false);
    expect(ticker.started).toBe(true);
  });

  it("can rest and wake again many times over", () => {
    const ticker = fakeTicker();
    const gate = new IdleGate(ticker);
    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < QUIET_FRAMES_BEFORE_STOP; i++) gate.frameDone(false);
      expect(ticker.started).toBe(false);
      gate.wake();
      expect(ticker.started).toBe(true);
    }
    expect(ticker.stops).toBe(5);
    expect(ticker.starts).toBe(5);
  });
});

describe("wakeOnActivity", () => {
  function setup() {
    const wake = vi.fn();
    const win = new EventTarget();
    const canvas = new EventTarget();
    const doc = new EventTarget();
    const detach = wakeOnActivity({ wake }, { window: win, canvas, document: doc });
    return { wake, win, canvas, doc, detach };
  }
  const pointer = (type: string, buttons: number) => Object.assign(new Event(type), { buttons });

  it("wakes on keys, on a click or touch on the canvas, on scrolling the wheel over it, on letting go, and on a resized window", () => {
    const { wake, win, canvas } = setup();
    win.dispatchEvent(new Event("keydown"));
    win.dispatchEvent(new Event("keyup"));
    win.dispatchEvent(new Event("resize"));
    win.dispatchEvent(pointer("pointerup", 0));
    canvas.dispatchEvent(pointer("pointerdown", 1));
    canvas.dispatchEvent(new Event("wheel"));
    expect(wake).toHaveBeenCalledTimes(6);
  });

  it("wakes when the tab becomes visible again", () => {
    const { wake, doc } = setup();
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("wakes while dragging, but not while the mouse just moves across the page", () => {
    const { wake, win } = setup();
    win.dispatchEvent(pointer("pointermove", 0));
    win.dispatchEvent(pointer("pointermove", 0));
    expect(wake).not.toHaveBeenCalled();
    win.dispatchEvent(pointer("pointermove", 1));
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it("stops listening completely when detached", () => {
    const { wake, win, canvas, doc, detach } = setup();
    detach();
    win.dispatchEvent(new Event("keydown"));
    win.dispatchEvent(new Event("resize"));
    canvas.dispatchEvent(pointer("pointerdown", 1));
    canvas.dispatchEvent(new Event("wheel"));
    doc.dispatchEvent(new Event("visibilitychange"));
    expect(wake).not.toHaveBeenCalled();
  });

  it("adds and removes exactly the same listeners, so nothing is left behind", () => {
    const targets = [new EventTarget(), new EventTarget(), new EventTarget()] as const;
    const added: string[] = [];
    const removed: string[] = [];
    for (const [i, t] of targets.entries()) {
      const add = t.addEventListener.bind(t);
      const remove = t.removeEventListener.bind(t);
      t.addEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, (boolean | AddEventListenerOptions)?]) => {
        added.push(`${i}:${type}`);
        return add(type, ...rest);
      }) as typeof t.addEventListener;
      t.removeEventListener = ((type: string, ...rest: [EventListenerOrEventListenerObject, (boolean | EventListenerOptions)?]) => {
        removed.push(`${i}:${type}`);
        return remove(type, ...rest);
      }) as typeof t.removeEventListener;
    }
    const detach = wakeOnActivity({ wake: () => {} }, { window: targets[0], canvas: targets[1], document: targets[2] });
    expect(added.length).toBeGreaterThan(0);
    detach();
    expect([...removed].sort()).toEqual([...added].sort());
  });
});

describe("tickerGroup: several clocks that rest and wake together", () => {
  it("starts and stops every clock in the group, and reports whether the main one is running", () => {
    const main = fakeTicker(false);
    const other = fakeTicker(false);
    const group = tickerGroup(main, other);
    expect(group.started).toBe(false);
    group.start();
    expect(main.started).toBe(true);
    expect(other.started).toBe(true);
    expect(group.started).toBe(true);
    group.stop();
    expect(main.started).toBe(false);
    expect(other.started).toBe(false);
    expect(group.started).toBe(false);
  });

  it("puts the other clock to sleep and wakes it along with the main one, through the gate", () => {
    const main = fakeTicker(true);
    const other = fakeTicker(true);
    const gate = new IdleGate(tickerGroup(main, other));
    for (let i = 0; i < QUIET_FRAMES_BEFORE_STOP; i++) gate.frameDone(false);
    expect(main.started).toBe(false);
    expect(other.started).toBe(false);
    gate.wake();
    expect(main.started).toBe(true);
    expect(other.started).toBe(true);
  });

  it("wakes the other clock even if it had stopped on its own, as long as the main one was resting", () => {
    const main = fakeTicker(false);
    const other = fakeTicker(false);
    new IdleGate(tickerGroup(main, other)).wake();
    expect(other.started).toBe(true);
  });
});
