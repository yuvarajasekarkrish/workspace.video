import type { Point } from "@cosmos/shared";

/**
 * Pure hit-testing for canvas objects, sibling to viewportMath.ts and built
 * the same way: the repo does raw DOM pointer events + world-space math
 * rather than Pixi's federated event system (see Viewport.ts), so object
 * selection follows that same approach rather than turning on
 * `eventMode: "static"` — this keeps arbitration deterministic and testable
 * with no Pixi Application involved at all.
 */
export interface HitTestableObject {
  objectId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  z: number;
}

/** Returns the topmost object (highest z; ties broken by later array
 *  position, i.e. "last drawn wins") whose bounds contain `worldPoint`, or
 *  null if none do. */
export function hitTestObjects(objects: readonly HitTestableObject[], worldPoint: Point): string | null {
  let best: HitTestableObject | null = null;

  for (const obj of objects) {
    const inside =
      worldPoint.x >= obj.x &&
      worldPoint.x <= obj.x + obj.width &&
      worldPoint.y >= obj.y &&
      worldPoint.y <= obj.y + obj.height;
    if (!inside) continue;

    if (!best || obj.z >= best.z) best = obj;
  }

  return best?.objectId ?? null;
}

export const RESIZE_HANDLES = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;
export type ResizeHandle = (typeof RESIZE_HANDLES)[number];

export interface ObjectBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** World-space position of one resize handle, at the corner/edge midpoint
 *  its name implies. */
export function handlePosition(bounds: ObjectBounds, handle: ResizeHandle): Point {
  const { x, y, width, height } = bounds;
  const cx = x + width / 2;
  const cy = y + height / 2;
  switch (handle) {
    case "nw":
      return { x, y };
    case "n":
      return { x: cx, y };
    case "ne":
      return { x: x + width, y };
    case "e":
      return { x: x + width, y: cy };
    case "se":
      return { x: x + width, y: y + height };
    case "s":
      return { x: cx, y: y + height };
    case "sw":
      return { x, y: y + height };
    case "w":
      return { x, y: cy };
  }
}

const DEFAULT_HANDLE_SIZE_PX = 8;

/**
 * Returns which resize handle (if any) `worldPoint` is within
 * `handleSizePx` (in SCREEN pixels, converted via `scale`) of. Dividing by
 * scale is what keeps the hit area a constant on-screen size at any zoom
 * level, matching how the handles themselves are meant to be drawn.
 */
export function hitTestResizeHandle(
  bounds: ObjectBounds,
  worldPoint: Point,
  scale: number,
  handleSizePx: number = DEFAULT_HANDLE_SIZE_PX,
): ResizeHandle | null {
  const radiusWorld = handleSizePx / 2 / scale;

  for (const handle of RESIZE_HANDLES) {
    const pos = handlePosition(bounds, handle);
    if (Math.hypot(worldPoint.x - pos.x, worldPoint.y - pos.y) <= radiusWorld) {
      return handle;
    }
  }
  return null;
}

/**
 * Applies a resize-handle drag to a bounds rect, given the pointer's total
 * world-space delta since the drag started. Opposite edges/corners stay
 * anchored (dragging "se" moves only the bottom-right corner; "n" moves
 * only the top edge, etc.) — the conventional resize-handle behavior.
 * `minSize` prevents collapsing an object to zero or negative dimensions.
 */
export function applyResize(
  original: ObjectBounds,
  handle: ResizeHandle,
  delta: Point,
  minSize = 20,
): ObjectBounds {
  let { x, y, width, height } = original;
  const right = original.x + original.width;
  const bottom = original.y + original.height;

  const affectsLeft = handle === "nw" || handle === "w" || handle === "sw";
  const affectsRight = handle === "ne" || handle === "e" || handle === "se";
  const affectsTop = handle === "nw" || handle === "n" || handle === "ne";
  const affectsBottom = handle === "sw" || handle === "s" || handle === "se";

  if (affectsLeft) {
    x = Math.min(original.x + delta.x, right - minSize);
    width = right - x;
  }
  if (affectsRight) {
    width = Math.max(original.width + delta.x, minSize);
  }
  if (affectsTop) {
    y = Math.min(original.y + delta.y, bottom - minSize);
    height = bottom - y;
  }
  if (affectsBottom) {
    height = Math.max(original.height + delta.y, minSize);
  }

  return { x, y, width, height };
}
