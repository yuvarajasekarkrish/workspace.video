import { Container, Graphics, Text, Sprite, Assets, Texture } from "pixi.js";
import type { ObjectState } from "@cosmos/shared";
import type { ObjectRender } from "@/store/objectsStore";

const SELECTION_COLOR = 0x4f8cff;
const NOTE_FILL: Record<string, number> = {
  yellow: 0xfff3a0,
  pink: 0xffc9de,
  blue: 0xaee1ff,
  green: 0xc4f2c2,
  purple: 0xdcc9ff,
};

function hexToNumber(hex: string, fallback: number): number {
  const parsed = Number.parseInt(hex.replace("#", ""), 16);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * One display object per canvas object. Follows the same wrapper-class
 * contract as canvas/Avatar.ts: a public `readonly container`, private
 * children, diffing/idempotent update, and a `destroy()` that tears the
 * container down. Unlike Avatar (one fixed shape), a single ObjectView
 * redraws itself differently per `type` rather than five separate classes —
 * none of this repo's other Pixi display wrappers are unit-tested (only the
 * pure modules and stores are, per the existing test boundary — see
 * viewportMath/movement/interpolation vs. the untested Viewport/PixiStage/
 * Avatar), so per-type subclassing would add file count without adding
 * anything this test suite actually exercises.
 *
 * `embed` has no implemented rendering this phase (see the approved plan's
 * "out of scope" section) — it falls through to the inert placeholder
 * rather than throwing, so an unexpected/future type never crashes the
 * canvas.
 */
export class ObjectView {
  readonly container = new Container();
  private readonly body = new Graphics();
  private readonly label = new Text({ text: "", style: { fontSize: 13, fill: 0x1a1a1a, wordWrap: true } });
  private readonly selectionOutline = new Graphics();
  private readonly resizeHandles = new Graphics();
  private sprite: Sprite | null = null;

  private lastType: ObjectState["type"] | null = null;
  private lastDataKey = "";
  private lastRect: ObjectRender = { x: 0, y: 0, width: 0, height: 0 };
  private lastSelected = false;

  constructor(objectId: string) {
    this.container.label = objectId;
    this.container.addChild(this.body, this.label, this.selectionOutline, this.resizeHandles);
  }

  /** Idempotent: redraws only the parts that actually changed since the
   *  last call, following Avatar.setName's "compare before assigning"
   *  pattern — called every ticker frame from PixiStage's renderFrame, so
   *  doing real work here unconditionally would be wasteful even though
   *  it's cheap Graphics/Text updates, not a store write. */
  update(state: ObjectState, rect: ObjectRender, isSelected: boolean): void {
    this.container.position.set(rect.x, rect.y);
    this.container.zIndex = state.z;

    const dataKey = JSON.stringify(state.data);
    const rectChanged =
      rect.width !== this.lastRect.width || rect.height !== this.lastRect.height;
    if (state.type !== this.lastType || dataKey !== this.lastDataKey || rectChanged) {
      this.redrawBody(state, rect);
      this.lastType = state.type;
      this.lastDataKey = dataKey;
      this.lastRect = { ...rect };
    }

    if (isSelected !== this.lastSelected || rectChanged) {
      this.redrawSelectionChrome(rect, isSelected);
      this.lastSelected = isSelected;
    }
  }

  private redrawBody(state: ObjectState, rect: ObjectRender): void {
    this.body.clear();
    this.label.text = "";
    if (this.sprite) {
      this.sprite.destroy();
      this.sprite = null;
    }

    switch (state.type) {
      case "note": {
        const color = typeof state.data.color === "string" ? state.data.color : "yellow";
        this.body.roundRect(0, 0, rect.width, rect.height, 4).fill(NOTE_FILL[color] ?? NOTE_FILL.yellow);
        this.label.text = typeof state.data.text === "string" ? state.data.text : "";
        this.label.style.wordWrapWidth = rect.width - 16;
        this.label.position.set(8, 8);
        break;
      }
      case "link": {
        this.body.roundRect(0, 0, rect.width, rect.height, 6).fill(0xffffff).stroke({ width: 1, color: 0xd0d4dc });
        const title = typeof state.data.title === "string" ? state.data.title : "";
        const url = typeof state.data.url === "string" ? state.data.url : "";
        this.label.text = title || url;
        this.label.style.wordWrapWidth = rect.width - 16;
        this.label.position.set(8, 8);
        break;
      }
      case "shape": {
        const kind = typeof state.data.kind === "string" ? state.data.kind : "rect";
        const fill = hexToNumber(typeof state.data.fill === "string" ? state.data.fill : "#4f8cff", 0x4f8cff);
        const stroke = hexToNumber(typeof state.data.stroke === "string" ? state.data.stroke : "#ffffff", 0xffffff);
        const strokeWidth = typeof state.data.strokeWidth === "number" ? state.data.strokeWidth : 2;
        if (kind === "ellipse") {
          this.body.ellipse(rect.width / 2, rect.height / 2, rect.width / 2, rect.height / 2);
        } else if (kind === "triangle") {
          this.body.poly([rect.width / 2, 0, rect.width, rect.height, 0, rect.height]);
        } else {
          this.body.rect(0, 0, rect.width, rect.height);
        }
        this.body.fill(fill).stroke({ width: strokeWidth, color: stroke });
        break;
      }
      case "zone": {
        const color = hexToNumber(typeof state.data.color === "string" ? state.data.color : "#50c878", 0x50c878);
        this.body.rect(0, 0, rect.width, rect.height).fill({ color, alpha: 0.12 }).stroke({ width: 2, color, alpha: 0.5 });
        this.label.text = typeof state.data.label === "string" ? state.data.label : "";
        this.label.style.fill = color;
        this.label.position.set(8, 8);
        break;
      }
      case "image": {
        const url = typeof state.data.url === "string" ? state.data.url : null;
        // Placeholder while (or if) the texture never loads — matches this
        // module's "never crash on unexpected data" rule for embed too.
        this.body.rect(0, 0, rect.width, rect.height).fill(0x1c2130).stroke({ width: 1, color: 0x3a4266 });
        if (url) this.loadImage(url, rect);
        break;
      }
      case "embed":
      default: {
        // Not implemented this phase — inert placeholder, never a crash.
        this.body.rect(0, 0, rect.width, rect.height).fill(0x2a2f3d).stroke({ width: 1, color: 0x4a5066 });
        this.label.text = "Embed (not supported yet)";
        this.label.style.fill = 0x8890a0;
        this.label.position.set(8, 8);
        break;
      }
    }
  }

  private loadImage(url: string, rect: ObjectRender): void {
    Assets.load<Texture>(url)
      .then((texture) => {
        // The view (or the whole object) may have been destroyed, or
        // redrawn to a different type/url, by the time the network request
        // resolves — never mutate a torn-down or superseded display object.
        if (this.container.destroyed || this.lastDataKey !== JSON.stringify({ url })) return;
        this.sprite?.destroy();
        this.sprite = new Sprite(texture);
        this.sprite.width = rect.width;
        this.sprite.height = rect.height;
        this.container.addChildAt(this.sprite, 1); // above body, below label/selection
      })
      .catch(() => {
        // Broken URL — the placeholder rect drawn above stays visible, which
        // is the intended "never crash on bad user-supplied data" outcome.
      });
  }

  private redrawSelectionChrome(rect: ObjectRender, isSelected: boolean): void {
    this.selectionOutline.clear();
    this.resizeHandles.clear();
    if (!isSelected) return;

    this.selectionOutline.rect(-2, -2, rect.width + 4, rect.height + 4).stroke({ width: 2, color: SELECTION_COLOR });

    const handleSize = 8;
    const positions: [number, number][] = [
      [0, 0],
      [rect.width / 2, 0],
      [rect.width, 0],
      [rect.width, rect.height / 2],
      [rect.width, rect.height],
      [rect.width / 2, rect.height],
      [0, rect.height],
      [0, rect.height / 2],
    ];
    for (const [hx, hy] of positions) {
      this.resizeHandles
        .rect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize)
        .fill(0xffffff)
        .stroke({ width: 1, color: SELECTION_COLOR });
    }
  }

  destroy(): void {
    this.sprite?.destroy();
    this.container.destroy({ children: true });
  }
}
