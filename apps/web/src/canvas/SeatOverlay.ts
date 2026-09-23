import { Container, Graphics, Matrix } from "pixi.js";
import type { Point, RoomLayout } from "@workspace-video/shared";
import { slabAt, type FloorPlan } from "./slabPlan";
import { ROOM_FREE_RING, ROOM_SELF, ROOM_TAKEN } from "./palette";
import { uprightMatrix } from "./isoMath";

const MARKER_RADIUS = 9;
const OCCUPIED_COLOR = ROOM_TAKEN;

/**
 * The one small piece of DYNAMIC furniture rendering — a tint marker over
 * each occupied seat. Everything else about the floor (FloorView.ts) is
 * static and built once; this overlay is built once too (one Graphics per
 * seat, all initially hidden) but toggled on seatsStore changes, never on
 * every ticker frame — occupancy changes at join/leave/sit/stand frequency,
 * not per frame, so a store subscription (not the render loop) is what
 * drives it. See PixiStage's seatsStore.subscribe wiring.
 */
export class SeatOverlay {
  readonly container = new Container();
  private readonly markers = new Map<string, Graphics>();
  /** A ring over each seat, shown only for the free seats in the area under the mouse: where you could sit. */
  private readonly freeRings = new Map<string, Graphics>();
  private occupancy: ReadonlyMap<string, string> = new Map();
  private hoveredSlab: string | null = null;
  private readonly anchors = new Map<string, Point>();
  /** Which plate each seat is on, so its marker rises with that plate. */
  private readonly slabOfSeat = new Map<string, string>();
  private readonly upright: ReturnType<typeof uprightMatrix>;

  constructor(layout: RoomLayout, plan: FloorPlan, tilted = true) {
    const u = uprightMatrix(tilted); // markers stand up straight on the floor, so they stay round
    this.upright = u;
    for (const seat of layout.seats) {
      // taken: a black dot with a white rim (reads on a white chair and on the floor alike)
      const marker = new Graphics().circle(0, 0, MARKER_RADIUS).fill(OCCUPIED_COLOR).stroke({ width: 2, color: ROOM_SELF });
      marker.setFromMatrix(new Matrix(u.a, u.b, u.c, u.d, seat.anchor.x, seat.anchor.y));
      marker.visible = false;
      // free: a dashed white ring, so free and taken differ by shape as well as by fill
      const ring = new Graphics();
      const dashes = 10, r = MARKER_RADIUS + 3;
      for (let i = 0; i < dashes; i++) {
        const a0 = (i / dashes) * Math.PI * 2, a1 = a0 + (Math.PI * 2) / dashes / 2;
        ring.moveTo(Math.cos(a0) * r, Math.sin(a0) * r).arc(0, 0, r, a0, a1).stroke({ width: 2.5, color: ROOM_FREE_RING });
      }
      ring.setFromMatrix(new Matrix(u.a, u.b, u.c, u.d, seat.anchor.x, seat.anchor.y));
      ring.visible = false;
      this.container.addChild(ring, marker);
      this.freeRings.set(seat.id, ring);
      this.markers.set(seat.id, marker);
      this.anchors.set(seat.id, { x: seat.anchor.x, y: seat.anchor.y });
      const slab = slabAt(plan, seat.anchor);
      if (slab) this.slabOfSeat.set(seat.id, slab.id);
    }
  }

  /** Moves the markers on one plate by `step` (the same step the plate itself was raised by). */
  liftSlab(slabId: string, step: Point): void {
    const u = this.upright;
    for (const [seatId, id] of this.slabOfSeat) {
      if (id !== slabId) continue;
      const anchor = this.anchors.get(seatId)!;
      const m = new Matrix(u.a, u.b, u.c, u.d, anchor.x + step.x, anchor.y + step.y);
      this.markers.get(seatId)?.setFromMatrix(m);
      this.freeRings.get(seatId)?.setFromMatrix(m);
    }
  }

  /** Called on every seatsStore change (not per frame) — cheap even at
   *  hundreds of seats since it's a plain visibility toggle, no redraw. */
  update(occupancy: ReadonlyMap<string, string>): void {
    this.occupancy = occupancy;
    for (const [seatId, marker] of this.markers) {
      marker.visible = occupancy.has(seatId);
    }
    this.showFreeOn(this.hoveredSlab);
  }

  /** Shows a ring on every free seat of one plate (the one under the mouse), or on none. A visibility toggle only. */
  showFreeOn(slabId: string | null): void {
    this.hoveredSlab = slabId;
    for (const [seatId, ring] of this.freeRings) {
      ring.visible = slabId !== null && this.slabOfSeat.get(seatId) === slabId && !this.occupancy.has(seatId);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
