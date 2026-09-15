import { Container, Graphics, Text } from "pixi.js";

const RADIUS = 22;
const LOCAL_COLOR = 0x4f8cff;
const REMOTE_COLOR = 0x50c878;
const LABEL_COLOR = 0xe6e8eb;
const SEATED_RING_COLOR = 0x4c6fe0;
const SEATED_RING_RADIUS = RADIUS + 6;

/**
 * One display object per peer. Deliberately dumb: it exposes only
 * `setPosition`/`setName`/`setSeated`, called every ticker frame or on
 * occupancy change respectively — it never reads any store itself, keeping
 * all store-to-Pixi wiring in PixiStage.ts. `setSeated` is a derived visual
 * only: it never carries a facing/orientation (the circle stays radially
 * symmetric — see the approved plan's note that Avatar has no orientation
 * system and none is being added just for seating).
 */
export class Avatar {
  readonly container: Container;
  private readonly circle: Graphics;
  private readonly label: Text;
  private readonly seatedRing: Graphics;

  constructor(name: string, isLocal: boolean) {
    this.container = new Container();

    this.circle = new Graphics()
      .circle(0, 0, RADIUS)
      .fill(isLocal ? LOCAL_COLOR : REMOTE_COLOR)
      .stroke({ width: isLocal ? 3 : 2, color: 0xffffff, alpha: isLocal ? 0.9 : 0.4 });
    this.container.addChild(this.circle);

    this.seatedRing = new Graphics().circle(0, 0, SEATED_RING_RADIUS).stroke({ width: 2, color: SEATED_RING_COLOR });
    this.seatedRing.visible = false;
    this.container.addChild(this.seatedRing);

    this.label = new Text({
      text: name,
      style: {
        fill: LABEL_COLOR,
        fontSize: 13,
        fontFamily: "ui-sans-serif, system-ui, sans-serif",
      },
    });
    this.label.anchor.set(0.5, 0);
    this.label.position.set(0, RADIUS + 6);
    this.container.addChild(this.label);
  }

  setPosition(x: number, y: number): void {
    this.container.position.set(x, y);
  }

  setName(name: string): void {
    if (this.label.text !== name) this.label.text = name;
  }

  /** Derived purely from seat occupancy (see seatsStore.ts) — never a
   *  transmitted flag of its own. */
  setSeated(seated: boolean): void {
    this.seatedRing.visible = seated;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
