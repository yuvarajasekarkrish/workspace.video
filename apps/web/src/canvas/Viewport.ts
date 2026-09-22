import { Container, Matrix } from "pixi.js";
import type { Point } from "@workspace-video/shared";
import { exceedsDragThreshold } from "./viewportMath";
import { fitFloor, isoMatrix, project, unproject, zoomAtCursor } from "./isoMath";

export interface ViewportCallbacks {
  /** Fired on a left click that never exceeded the drag threshold. */
  onClickToWalk: (worldPoint: Point) => void;
  /** Consulted first on every left-button press (unless space is held,
   *  which always forces panning regardless of what's under the cursor —
   *  the deliberate escape hatch to pan over objects), given the
   *  world-space point under the cursor. Returning true CLAIMS the gesture
   *  for object interaction (select/drag/resize): Viewport will not pan,
   *  and the eventual release will not be treated as a click-to-walk.
   *  Returning false/omitting the callback falls through to the existing
   *  pan/click-to-walk arbitration, unchanged. */
  onObjectGestureStart?: (worldPoint: Point) => boolean;
  /** Called on every pointermove while an object gesture is claimed. */
  onObjectGestureMove?: (worldPoint: Point) => void;
  /** Called once when a claimed object gesture ends (pointerup). */
  onObjectGestureEnd?: () => void;
  /** Consulted after onObjectGestureStart declines, in the same
   *  space-held-bypasses-everything / left-button-only slot — a hit on a
   *  seat (see canvas/objects... no: @workspace-video/shared's hitTestSeats over the
   *  room's static layout). Unlike an object gesture, sitting is a discrete
   *  action with no drag/resize follow-through, so there is no matching
   *  move/end pair: returning true here only suppresses this press's pan
   *  and click-to-walk — the caller does the actual "attempt to sit" work
   *  synchronously inside the callback itself. */
  onFurnitureGestureStart?: (worldPoint: Point) => boolean;
  /** Fired only when the zoom value itself actually changes (fit, the zoom buttons, the wheel) —
   *  never on a plain pan, which does not touch zoom. Lets things that must stay a fixed size on
   *  screen (FloorView's area labels, D17 5B) recompute their counter-scale without doing that work
   *  on every frame or every pixel of panning. */
  onZoomChanged?: (scale: number) => void;
}

/**
 * Imperative shell around viewportMath.ts and isoMath.ts's pure functions: owns the
 * `world` container's tilted (2.5D) pan/zoom transform and translates raw DOM pointer/
 * wheel/keyboard events into calls to that pure logic. The floor is turned 45 degrees and leaned back
 * 55 degrees, like the Gemini map, so every screen position is un-tilted (isoMath.unproject) before it
 * is handed to anything that thinks in flat floor positions. Pointer arbitration
 * (click vs pan vs space-pan vs middle-pan) follows the milestone's fixed
 * rule table:
 *
 *   left press+release, < 5px total movement  -> click-to-walk
 *   left drag beyond 5px                      -> pan (click cancelled)
 *   space held + left drag                    -> pan, always, any distance
 *   middle-button drag                        -> pan
 *   wheel                                     -> cursor-anchored zoom, 0.1x-3x
 *
 * All DOM listeners this attaches are removed in `dispose()` — see the
 * plan's lifecycle-disposal requirement; a leaked listener here is exactly
 * the kind of bug that produces duplicate pan handlers after navigating
 * away from and back to a room.
 */
export class Viewport {
  readonly world = new Container();
  /** Where the floor's top-left corner is on the screen, and the zoom. Together with the view mode they are the whole view. */
  private origin: Point = { x: 0, y: 0 };
  private zoom = 1;
  /** True from a fit until the person zooms or moves the view themselves. A window resize re-fits only while true. */
  private fitted = false;
  /** Whether the floor is drawn tilted (default, the Gemini look) or flat (looking straight down) —
   *  a workspace-wide admin setting (D20), fixed for the life of this Viewport. */
  private readonly tilted: boolean;

  private spaceHeld = false;
  private activePointerId: number | null = null;
  private isPanning = false;
  private objectGestureClaimed = false;
  private furnitureGestureClaimed = false;
  private pressStart: Point = { x: 0, y: 0 };
  private panOriginScreen: Point = { x: 0, y: 0 };
  private panOriginWorld: Point = { x: 0, y: 0 };
  private pointerButton = 0;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly callbacks: ViewportCallbacks,
    tilted = true,
  ) {
    this.tilted = tilted;
    this.applyTransform();
    this.attach();
  }

  /** Puts the tilt (or not), zoom and position onto the world container. */
  private applyTransform(): void {
    const m = isoMatrix(this.zoom, this.tilted);
    this.world.setFromMatrix(new Matrix(m.a, m.b, m.c, m.d, this.origin.x, this.origin.y));
  }

  /** Sets the zoom and, only when it actually changed, tells onZoomChanged — never on a plain pan. */
  private setZoom(value: number): void {
    if (value === this.zoom) return;
    this.zoom = value;
    this.callbacks.onZoomChanged?.(value);
  }

  /** Shows the whole floor, centred, inside a window of this size. Used when the room opens and for a "fit" button. */
  fitToFloor(floor: { width: number; height: number }, view: { width: number; height: number }): void {
    const fit = fitFloor(floor, view, 0.92, this.tilted);
    this.setZoom(fit.scale);
    this.origin = fit.position;
    this.fitted = true;
    this.applyTransform();
  }

  /** Whether the view is still the whole-map fit, untouched by the person since. */
  isFitted(): boolean {
    return this.fitted;
  }

  /** Where a flat floor position appears on the screen (used to place the note editor over a note). */
  worldToScreen(world: Point): Point {
    return project(world, this.origin, this.zoom, this.tilted);
  }

  private attach(): void {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    this.canvas.addEventListener("pointerdown", this.onPointerDown);
    window.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("pointerup", this.onPointerUp);
    this.canvas.addEventListener("wheel", this.onWheel, { passive: false });
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    this.canvas.removeEventListener("pointerdown", this.onPointerDown);
    window.removeEventListener("pointermove", this.onPointerMove);
    window.removeEventListener("pointerup", this.onPointerUp);
    this.canvas.removeEventListener("wheel", this.onWheel);
  }

  screenToWorld(screen: Point): Point {
    return unproject(screen, this.origin, this.zoom, this.tilted);
  }

  /** Current zoom scale — needed by object interaction's resize-handle
   *  hit-testing so a handle's hit area stays a constant size on screen
   *  regardless of zoom (see objectHitTest.ts's hitTestResizeHandle). */
  getScale(): number {
    return this.zoom;
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === "Space") {
      this.spaceHeld = true;
      this.canvas.style.cursor = "grab";
    }
  };

  private onKeyUp = (e: KeyboardEvent): void => {
    if (e.code === "Space") {
      this.spaceHeld = false;
      this.canvas.style.cursor = "default";
    }
  };

  private onPointerDown = (e: PointerEvent): void => {
    const isLeft = e.button === 0;
    const isMiddle = e.button === 1;
    if (!isLeft && !isMiddle) return;

    this.activePointerId = e.pointerId;
    this.pointerButton = e.button;
    this.pressStart = { x: e.clientX, y: e.clientY };
    this.panOriginScreen = { x: e.clientX, y: e.clientY };
    this.panOriginWorld = { x: this.origin.x, y: this.origin.y };

    // Space-held always forces panning regardless of what's under the
    // cursor — the deliberate escape hatch to pan over objects — so object
    // hit-testing is skipped entirely in that case.
    const pt = this.pointerWorldPoint(e);
    this.objectGestureClaimed =
      isLeft && !this.spaceHeld && (this.callbacks.onObjectGestureStart?.(pt) ?? false);
    this.furnitureGestureClaimed =
      isLeft && !this.spaceHeld && !this.objectGestureClaimed && (this.callbacks.onFurnitureGestureStart?.(pt) ?? false);

    // Middle-button and space-held left-button always pan, regardless of
    // how far the pointer ends up moving; a plain left press stays
    // ambiguous until onPointerMove sees it cross the drag threshold —
    // unless an object or furniture gesture just claimed it, which
    // pre-empts both.
    this.isPanning =
      !this.objectGestureClaimed && !this.furnitureGestureClaimed && (isMiddle || (isLeft && this.spaceHeld));
  };

  private onPointerMove = (e: PointerEvent): void => {
    if (this.activePointerId === null || e.pointerId !== this.activePointerId) return;

    if (this.objectGestureClaimed) {
      this.callbacks.onObjectGestureMove?.(this.pointerWorldPoint(e));
      return;
    }
    // Furniture gestures have no drag follow-through — just suppress pan.
    if (this.furnitureGestureClaimed) return;

    if (!this.isPanning && exceedsDragThreshold(this.pressStart, { x: e.clientX, y: e.clientY })) {
      this.isPanning = true;
    }

    if (this.isPanning) {
      this.origin = {
        x: this.panOriginWorld.x + (e.clientX - this.panOriginScreen.x),
        y: this.panOriginWorld.y + (e.clientY - this.panOriginScreen.y),
      };
      this.fitted = false;
      this.applyTransform();
    }
  };

  private onPointerUp = (e: PointerEvent): void => {
    if (this.activePointerId === null || e.pointerId !== this.activePointerId) return;

    const wasPanning = this.isPanning;
    const wasLeftButton = this.pointerButton === 0;
    const wasObjectGesture = this.objectGestureClaimed;
    const wasFurnitureGesture = this.furnitureGestureClaimed;
    this.activePointerId = null;
    this.isPanning = false;
    this.objectGestureClaimed = false;
    this.furnitureGestureClaimed = false;

    if (wasObjectGesture) {
      this.callbacks.onObjectGestureEnd?.();
      return;
    }
    // Already handled synchronously inside onFurnitureGestureStart — a
    // claimed furniture press never becomes a click-to-walk.
    if (wasFurnitureGesture) return;

    // A left press that never exceeded the drag threshold (and wasn't
    // forced into panning by space, and didn't claim an object or seat) is
    // a click-to-walk.
    if (!wasPanning && wasLeftButton) {
      const rect = this.canvas.getBoundingClientRect();
      const screen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      this.callbacks.onClickToWalk(this.screenToWorld(screen));
    }
  };

  private pointerWorldPoint(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return this.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  }

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const rect = this.canvas.getBoundingClientRect();
    const cursorScreen = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    this.zoomAt(cursorScreen, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  };

  /** Zooms by `factor`, keeping the floor position under `anchor` (a screen position) exactly where it is. */
  zoomAt(anchor: Point, factor: number): void {
    const { scale, position } = zoomAtCursor(anchor, this.origin, this.zoom, factor, undefined, undefined, this.tilted);
    this.setZoom(scale);
    this.origin = position;
    this.fitted = false;
    this.applyTransform();
  }
}
