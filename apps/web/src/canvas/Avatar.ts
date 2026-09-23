import { Container, Graphics, Matrix, Text } from "pixi.js";
import { uprightMatrix } from "./isoMath";
import { BLACK, NAME_TAG_TEXT, ROOM_OUTLINE, ROOM_PERSON, ROOM_SELF, WHITE } from "./palette";

// The Gemini design's people: a slate dot for everyone else, an accent dot with a soft glow for you, and a small
// dark name tag above (docs/designs/gemini-landing.html.html), shown only where it's useful (see setNameVisible;
// D17, decision 5B) so 200 people stay readable.
const RADIUS = 15;
const YOU_RADIUS = 17;
const SEATED_RING_RADIUS = RADIUS + 7;

/** How far, in floor pixels before zoom, the mouse counts as "hovering" this avatar (D17, 5B: the
 *  person under the mouse gets their name shown). A little larger than the dot itself, the same way
 *  a click target is usually a bit more forgiving than the thing it hits. PixiStage scales this by
 *  the current zoom, the same way the dot itself grows and shrinks with zoom. */
export const AVATAR_HOVER_RADIUS = 22;

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

  constructor(name: string, isLocal: boolean, tilted = true) {
    this.isLocal = isLocal;
    this.container = new Container();
    // In flat mode (D20) there is no tilt to cancel; uprightMatrix(false) correctly returns the
    // identity matrix, so this stays a single call regardless of the workspace's view mode.
    const u = uprightMatrix(tilted);
    this.body.setFromMatrix(new Matrix(u.a, u.b, u.c, u.d, 0, 0));
    this.container.addChild(this.body);

    if (isLocal) {
      const glow = new Graphics().circle(0, 0, YOU_RADIUS + 9).fill({ color: ROOM_SELF, alpha: 0.18 });
      this.body.addChild(glow);
    }
    const dot = new Graphics()
      .circle(0, 0, isLocal ? YOU_RADIUS : RADIUS)
      .fill(isLocal ? ROOM_SELF : ROOM_PERSON)
      // a dark outline keeps every person readable on a light chair or table (WCAG 1.4.11; see palette.ts)
      .stroke({ width: 3, color: ROOM_OUTLINE });
    this.body.addChild(dot);

    this.seatedRing = new Graphics().circle(0, 0, SEATED_RING_RADIUS).stroke({ width: 2, color: ROOM_SELF, alpha: 0.8 });
    this.seatedRing.visible = false;
    this.body.addChild(this.seatedRing);

    this.tag = new Graphics();
    this.body.addChild(this.tag);
    this.label = new Text({
      text: name,
      style: {
        fill: isLocal ? ROOM_SELF : NAME_TAG_TEXT,
        // 16 px on screen, per DESIGN.md's text-size floor and D17's decision 5B for the map's own
        // text (area labels and, where shown, a person's name).
        fontSize: 16,
        fontWeight: isLocal ? "600" : "500",
        fontFamily: "Inter Variable, ui-sans-serif, system-ui, sans-serif",
      },
    });
    this.label.anchor.set(0.5, 0.5);
    this.body.addChild(this.label);
    this.layoutTag(isLocal);
    // Shown/hidden every frame by PixiStage.setNameVisible per D17 5B; starts visible so a peer who
    // joins mid-frame (before the next renderFrame runs) is never drawn with no name tag logic
    // applied at all — the very next frame corrects it either way.
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
      .fill({ color: BLACK, alpha: 0.8 })
      .stroke({ width: 1, color: WHITE, alpha: isLocal ? 0.5 : 0.1 });
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

  /** Whether the name tag draws at all (D17, 5B): shown for you, people nearby, whoever is under
   *  the mouse, and anyone found through search; a plain dot otherwise. Recomputed by PixiStage
   *  every frame something is moving — this call is just "set the two shapes' visibility", nothing
   *  here reads any store or does its own distance math. */
  setNameVisible(visible: boolean): void {
    this.tag.visible = visible;
    this.label.visible = visible;
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}
