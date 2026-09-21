import { Container, Graphics, Matrix } from "pixi.js";
import { zoneAt, type Point, type RoomLayout } from "@workspace-video/shared";
import { uprightMatrix } from "./isoMath";

const MARKER_RADIUS = 9;
const OCCUPIED_COLOR = 0xf5a623; // the Gemini design's amber

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
  private readonly anchors = new Map<string, Point>();
  /** Which area each seat is in, so its marker rises with that area. */
  private readonly zoneOfSeat = new Map<string, string>();
  private readonly upright = uprightMatrix();

  constructor(layout: RoomLayout) {
    const u = uprightMatrix(); // markers stand up straight on the tilted floor, so they stay round
    for (const seat of layout.seats) {
      const marker = new Graphics().circle(0, 0, MARKER_RADIUS).fill(OCCUPIED_COLOR);
      marker.setFromMatrix(new Matrix(u.a, u.b, u.c, u.d, seat.anchor.x, seat.anchor.y));
      marker.visible = false;
      this.container.addChild(marker);
      this.markers.set(seat.id, marker);
      this.anchors.set(seat.id, { x: seat.anchor.x, y: seat.anchor.y });
      const zone = zoneAt(layout, seat.anchor);
      if (zone) this.zoneOfSeat.set(seat.id, zone.id);
    }
  }

  /** Moves the markers of one area by `step` (the same step the area itself was raised by). */
  liftZone(zoneId: string, step: Point): void {
    const u = this.upright;
    for (const [seatId, id] of this.zoneOfSeat) {
      if (id !== zoneId) continue;
      const anchor = this.anchors.get(seatId)!;
      this.markers.get(seatId)?.setFromMatrix(new Matrix(u.a, u.b, u.c, u.d, anchor.x + step.x, anchor.y + step.y));
    }
  }

  /** Called on every seatsStore change (not per frame) — cheap even at
   *  hundreds of seats since it's a plain visibility toggle, no redraw. */
  update(occupancy: ReadonlyMap<string, string>): void {
    for (const [seatId, marker] of this.markers) {
      marker.visible = occupancy.has(seatId);
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
