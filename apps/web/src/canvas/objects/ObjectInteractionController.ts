import type { Point, ObjectUpsertEvent, ObjectDeleteEvent, CanvasObjectType, ObjectState } from "@workspace-video/shared";
import { objectsStore, type ObjectRender } from "@/store/objectsStore";
import { hitTestObjects, hitTestResizeHandle, applyResize, type ResizeHandle } from "./objectHitTest";
import { shouldEmitObjectUpdate } from "./objectSync";

export interface ObjectInteractionCallbacks {
  onSendUpsert: (event: ObjectUpsertEvent) => void;
  onSendDelete: (event: ObjectDeleteEvent) => void;
  /** Current viewport zoom scale — resize-handle hit-testing needs this so
   *  the handle's hit area stays a constant size on screen (see
   *  objectHitTest.ts's hitTestResizeHandle). */
  getScale: () => number;
}

interface DragState {
  objectId: string;
  startWorld: Point;
  startRect: ObjectRender;
}

interface ResizeState {
  objectId: string;
  handle: ResizeHandle;
  startWorld: Point;
  startBounds: ObjectRender;
}

const THROTTLE_MS = 50; // matches the existing move-throttle contract (clientThrottleMs)

/**
 * Imperative shell for canvas-object interaction: select, drag, resize,
 * create, delete. Wired into Viewport's additive onObjectGestureStart/
 * Move/End callbacks (see Viewport.ts) so it participates in the same
 * pointer arbitration table as click-to-walk/pan, and into PixiStage's
 * keyboard handling for Delete/Escape.
 *
 * Every store interaction goes straight through objectsStore.getState() —
 * no React, no callback indirection for reads — matching MovementController
 * and SpatialAudioController's established shape in this codebase.
 */
export class ObjectInteractionController {
  private drag: DragState | null = null;
  private resize: ResizeState | null = null;
  private lastSentAtMs: number | null = null;
  private lastSentRect: ObjectRender | null = null;

  constructor(
    private readonly localUserId: string,
    private readonly roomId: string,
    private readonly callbacks: ObjectInteractionCallbacks,
  ) {}

  /** Consulted by Viewport on every left-button press. Returns true to
   *  claim the gesture (pre-empting pan/click-to-walk for this press). */
  handleGestureStart(worldPoint: Point): boolean {
    const state = objectsStore.getState();

    // A resize handle on the CURRENTLY SELECTED object takes priority over
    // hit-testing other objects — you must be able to grab a handle even
    // when the object underneath the cursor there is the selected one
    // itself (handles sit at/near its edges).
    if (state.selectedId) {
      const selected = state.objects.get(state.selectedId);
      if (selected) {
        const handle = hitTestResizeHandle(selected.render, worldPoint, this.callbacks.getScale());
        if (handle) {
          this.resize = { objectId: state.selectedId, handle, startWorld: worldPoint, startBounds: { ...selected.render } };
          return true;
        }
      }
    }

    const candidates = Array.from(state.objects.values()).map((r) => ({
      objectId: r.state.objectId,
      ...r.render,
      z: r.state.z,
    }));
    const hitId = hitTestObjects(candidates, worldPoint);

    if (!hitId) {
      // Click on empty canvas while something is selected: deselect, then
      // let the gesture fall through to the normal click-to-walk/pan
      // arbitration (returning false does exactly that).
      if (state.selectedId) state.setSelected(null);
      return false;
    }

    state.setSelected(hitId);
    const record = state.objects.get(hitId)!;
    this.drag = { objectId: hitId, startWorld: worldPoint, startRect: { ...record.render } };
    return true;
  }

  handleGestureMove(worldPoint: Point): void {
    if (this.resize) {
      const delta = { x: worldPoint.x - this.resize.startWorld.x, y: worldPoint.y - this.resize.startWorld.y };
      const next = applyResize(this.resize.startBounds, this.resize.handle, delta);
      objectsStore.getState().applyLocalEdit(this.resize.objectId, next);
      this.maybeEmit(this.resize.objectId);
      return;
    }

    if (this.drag) {
      const dx = worldPoint.x - this.drag.startWorld.x;
      const dy = worldPoint.y - this.drag.startWorld.y;
      const next: ObjectRender = {
        x: this.drag.startRect.x + dx,
        y: this.drag.startRect.y + dy,
        width: this.drag.startRect.width,
        height: this.drag.startRect.height,
      };
      objectsStore.getState().applyLocalEdit(this.drag.objectId, next);
      this.maybeEmit(this.drag.objectId);
    }
  }

  handleGestureEnd(): void {
    const objectId = this.drag?.objectId ?? this.resize?.objectId ?? null;
    this.drag = null;
    this.resize = null;
    // Final send bypasses the throttle unconditionally — otherwise the very
    // last frame's position (the one the user actually intended to end on)
    // could be swallowed by the throttle window and never reach the server.
    if (objectId) this.emitNow(objectId);
  }

  /** Creates a new object at `worldPoint` with a default size, optimistic
   *  on the client (baseVersion 0) and sent to the server immediately —
   *  same "optimistic, corrected later" shape any other object edit uses. */
  createObject(type: CanvasObjectType, worldPoint: Point, data: Record<string, unknown>): void {
    const objects = Array.from(objectsStore.getState().objects.values());
    const maxZ = objects.reduce((max, r) => Math.max(max, r.state.z), 0);
    const objectId = crypto.randomUUID();
    const size = type === "zone" ? { width: 400, height: 300 } : { width: 200, height: 150 };

    const optimistic: ObjectState = {
      objectId,
      roomId: this.roomId,
      type,
      x: worldPoint.x,
      y: worldPoint.y,
      width: size.width,
      height: size.height,
      rotation: 0,
      z: maxZ + 1,
      data,
      version: 0,
      createdById: this.localUserId,
    };
    objectsStore.getState().addOptimistic(optimistic);

    this.callbacks.onSendUpsert({
      objectId,
      roomId: this.roomId,
      type,
      x: optimistic.x,
      y: optimistic.y,
      width: optimistic.width,
      height: optimistic.height,
      rotation: 0,
      z: optimistic.z,
      data,
      baseVersion: 0,
    });
  }

  /** Deletes the currently selected object, if any. The server enforces
   *  creator-only — this just sends the request; a rejection comes back as
   *  a normal object:sync the store already knows how to reconcile. */
  deleteSelected(): void {
    const state = objectsStore.getState();
    if (!state.selectedId) return;
    const record = state.objects.get(state.selectedId);
    if (!record) return;

    this.callbacks.onSendDelete({
      objectId: record.state.objectId,
      roomId: this.roomId,
      baseVersion: record.state.version,
    });
  }

  deselect(): void {
    objectsStore.getState().setSelected(null);
  }

  private maybeEmit(objectId: string): void {
    const record = objectsStore.getState().objects.get(objectId);
    if (!record) return;
    const now = Date.now();
    if (!shouldEmitObjectUpdate(this.lastSentAtMs, this.lastSentRect, now, record.render, THROTTLE_MS)) return;
    this.emitNow(objectId, now);
  }

  private emitNow(objectId: string, now: number = Date.now()): void {
    const record = objectsStore.getState().objects.get(objectId);
    if (!record) return;
    this.lastSentAtMs = now;
    this.lastSentRect = { ...record.render };

    this.callbacks.onSendUpsert({
      objectId,
      roomId: this.roomId,
      type: record.state.type,
      x: record.render.x,
      y: record.render.y,
      width: record.render.width,
      height: record.render.height,
      rotation: record.state.rotation,
      z: record.state.z,
      data: record.state.data,
      baseVersion: record.state.version,
    });
  }
}
