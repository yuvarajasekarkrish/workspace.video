import type { Point } from "@workspace-video/shared";
import { unproject } from "./isoMath";
import { slabAt, type FloorPlan } from "./slabPlan";

/**
 * Raising an area when the mouse is over it, like the Gemini map (a platform rises and its shadow grows and
 * softens; nothing changes colour). Everything here is arithmetic; nothing draws.
 *
 * "Up" on the screen is not "up" on the flat floor (the floor is turned and leaned back), so a lift of H is turned
 * into the flat-floor step that makes a thing appear exactly H higher on the screen.
 */

/** How far an area rises while the mouse is over it, in floor pixels (before zoom). */
export const HOVER_LIFT = 30;
/** The lift moves this fraction of the remaining distance per second, so it eases in and out and always settles. */
const EASE_PER_SECOND = 14;
const SETTLED_WITHIN = 0.05;

/** The step across the flat floor that makes something appear `height` higher on the screen (and no sideways move). */
export function liftVector(height: number): Point {
  return unproject({ x: 0, y: -height }, { x: 0, y: 0 }, 1);
}

/** The step across the flat floor that moves something `right` and `down` on the screen (for cast shadows). */
export function screenStep(right: number, down: number): Point {
  return unproject({ x: right, y: down }, { x: 0, y: 0 }, 1);
}

/** One frame of easing toward a target, never overshooting; lands exactly on the target once close. */
export function stepLift(current: number, target: number, dtSeconds: number): number {
  if (Math.abs(target - current) <= SETTLED_WITHIN) return target;
  const next = current + (target - current) * Math.min(1, EASE_PER_SECOND * dtSeconds);
  return Math.abs(target - next) <= SETTLED_WITHIN ? target : next;
}

/**
 * Which plate the mouse is over. `floorPoint` is where the mouse lands on the flat floor. A plate that is already
 * raised is tested where it is drawn (raised), not where it sits, and keeps priority: otherwise the mouse near an
 * edge would raise the plate, the raised edge would slip away from the mouse, the plate would drop, and it would flicker.
 */
export function pickSlab(plan: FloorPlan, floorPoint: Point, current: { slabId: string; lift: number } | null): string | null {
  if (current) {
    const slab = plan.slabs.find((s) => s.id === current.slabId);
    if (slab) {
      const step = liftVector(current.lift);
      const p = { x: floorPoint.x - step.x, y: floorPoint.y - step.y };
      const r = slab.rect;
      if (p.x >= r.x && p.x < r.x + r.width && p.y >= r.y && p.y < r.y + r.height) return slab.id;
    }
  }
  return slabAt(plan, floorPoint)?.id ?? null;
}

/** The raise of every plate, and which one the mouse is over. */
export class LiftState {
  private readonly lifts = new Map<string, number>();
  private hovered: string | null = null;

  hoveredId(): string | null {
    return this.hovered;
  }

  liftOf(zoneId: string): number {
    return this.lifts.get(zoneId) ?? 0;
  }

  /** True while any area is off the floor or moving; the drawing loop must keep going until this is false. */
  isActive(): boolean {
    return this.hovered !== null || this.lifts.size > 0;
  }

  setHovered(zoneId: string | null): void {
    this.hovered = zoneId;
    if (zoneId !== null && !this.lifts.has(zoneId)) this.lifts.set(zoneId, 0);
  }

  /** Moves every area one frame toward its target and returns the ids whose lift changed. Areas back on the floor are forgotten. */
  step(dtSeconds: number): string[] {
    const changed: string[] = [];
    for (const [id, lift] of this.lifts) {
      const target = id === this.hovered ? HOVER_LIFT : 0;
      const next = stepLift(lift, target, dtSeconds);
      if (next !== lift) changed.push(id);
      if (next === 0 && target === 0) this.lifts.delete(id);
      else this.lifts.set(id, next);
    }
    return changed;
  }
}
