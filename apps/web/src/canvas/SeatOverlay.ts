import { Container, Graphics } from "pixi.js";
import type { RoomLayout } from "@workspace-video/shared";

const MARKER_RADIUS = 10;
const OCCUPIED_COLOR = 0x2e9e73;

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

  constructor(layout: RoomLayout) {
    for (const seat of layout.seats) {
      const marker = new Graphics().circle(0, 0, MARKER_RADIUS).fill(OCCUPIED_COLOR);
      marker.position.set(seat.anchor.x, seat.anchor.y);
      marker.visible = false;
      this.container.addChild(marker);
      this.markers.set(seat.id, marker);
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
