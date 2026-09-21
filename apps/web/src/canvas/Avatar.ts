import { Container, Graphics, Matrix, Text } from "pixi.js";
import { uprightMatrix } from "./isoMath";

// The Gemini design's people: a slate dot for everyone else, an amber dot with a soft glow for you, and a small dark
// name tag above (docs/designs/gemini-landing.html.html).
const RADIUS = 15;
const YOU_RADIUS = 17;
const AMBER = 0xf5a623;
const SLATE = 0x64748b;
const LABEL_COLOR = 0xe2e8f0;
const SEATED_RING_RADIUS = RADIUS + 7;

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
  /** Everything visible lives in here, un-tilted, so the dot stays round and the name stays level on the tilted floor. */
  private readonly body = new Container();
  private readonly label: Text;
  private readonly tag: Graphics;
  private readonly seatedRing: Graphics;
  private readonly isLocal: boolean;

  constructor(name: string, isLocal: boolean) {
    this.isLocal = isLocal;
    this.container = new Container();
    const u = uprightMatrix();
    this.body.setFromMatrix(new Matrix(u.a, u.b, u.c, u.d, 0, 0));
    this.container.addChild(this.body);

    if (isLocal) {
      const glow = new Graphics().circle(0, 0, YOU_RADIUS + 9).fill({ color: AMBER, alpha: 0.22 });
      this.body.addChild(glow);
    }
    const dot = new Graphics()
      .circle(0, 0, isLocal ? YOU_RADIUS : RADIUS)
      .fill(isLocal ? AMBER : SLATE)
      .stroke({ width: isLocal ? 3 : 2.5, color: isLocal ? 0xffffff : 0x1a1a1a });
    this.body.addChild(dot);

    this.seatedRing = new Graphics().circle(0, 0, SEATED_RING_RADIUS).stroke({ width: 2, color: AMBER, alpha: 0.7 });
    this.seatedRing.visible = false;
    this.body.addChild(this.seatedRing);

    this.tag = new Graphics();
    this.body.addChild(this.tag);
    this.label = new Text({
      text: name,
      style: {
        fill: isLocal ? AMBER : LABEL_COLOR,
        fontSize: 13,
        fontWeight: isLocal ? "600" : "500",
        fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif",
      },
    });
    this.label.anchor.set(0.5, 0.5);
    this.body.addChild(this.label);
    this.layoutTag(isLocal);
  }

  /** Sizes the dark name tag to the name and places it above the dot. */
  private layoutTag(isLocal: boolean): void {
    const padX = 10;
    const padY = 4;
    const width = this.label.width + padX * 2;
    const height = this.label.height + padY * 2;
    const centreY = -((isLocal ? YOU_RADIUS : RADIUS) + 8 + height / 2);
    this.tag
      .clear()
      .roundRect(-width / 2, centreY - height / 2, width, height, height / 2)
      .fill({ color: 0x000000, alpha: 0.8 })
      .stroke({ width: 1, color: isLocal ? AMBER : 0xffffff, alpha: isLocal ? 0.3 : 0.1 });
    this.label.position.set(0, centreY);
  }

  setPosition(x: number, y: number): void {
    this.container.position.set(x, y);
  }

  setName(name: string): void {
    if (this.label.text === name) return;
    this.label.text = name;
    this.layoutTag(this.isLocal);
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
