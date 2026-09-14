import { Container, Graphics, Text } from "pixi.js";

const RADIUS = 22;
const LOCAL_COLOR = 0x4f8cff;
const REMOTE_COLOR = 0x50c878;
const LABEL_COLOR = 0xe6e8eb;

/**
 * One display object per peer. Deliberately dumb: it exposes only
 * `setPosition`, called every ticker frame with the peer's current
 * `renderPosition`. It never reads the store itself — the ticker in
 * PixiStage.ts owns iterating peers and calling this, keeping the
 * store-to-Pixi wiring in one place.
 */
export class Avatar {
  readonly container: Container;
  private readonly circle: Graphics;
  private readonly label: Text;

  constructor(name: string, isLocal: boolean) {
    this.container = new Container();

    this.circle = new Graphics()
      .circle(0, 0, RADIUS)
      .fill(isLocal ? LOCAL_COLOR : REMOTE_COLOR)
      .stroke({ width: isLocal ? 3 : 2, color: 0xffffff, alpha: isLocal ? 0.9 : 0.4 });
    this.container.addChild(this.circle);

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

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
