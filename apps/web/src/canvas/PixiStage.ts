import { Application, Container, EventsTicker, Ticker } from "pixi.js";
import type { Point, RoomLayout } from "@workspace-video/shared";
import {
  DEFAULT_MOVEMENT_CONFIG,
  DEFAULT_PROXIMITY_CONFIG,
  movementConfigForLayout,
  hitTestSeats,
  furnitureAt,
  zoneById,
  tileRectCenter,
} from "@workspace-video/shared";
import { peersStore, type PeersState } from "@/store/peersStore";
import { nearbySeatStore } from "@/store/nearbySeatStore";
import { seatFeedbackStore } from "@/store/seatFeedbackStore";
import { objectsStore, type ObjectsState } from "@/store/objectsStore";
import { seatsStore } from "@/store/seatsStore";
import { createBackground } from "./Background";
import { buildFloorView, type FloorView } from "./FloorView";
import { LiftState, liftVector, pickSlab } from "./lift";
import { slabAt } from "./slabPlan";
import { GROUND_CSS } from "./palette";
import { SeatOverlay } from "./SeatOverlay";
import { Avatar, AVATAR_HOVER_RADIUS } from "./Avatar";
import { Viewport } from "./Viewport";
import { computeNameVisibility } from "./nameVisibility";
import { stepScalarToward } from "./interpolation";
import { IdleGate, tickerGroup, wakeOnActivity } from "./idleGate";
import { MovementController } from "@/input/MovementController";
import { RealtimeClient } from "@/net/RealtimeClient";
import { ObjectView } from "./objects/ObjectView";
import { ObjectInteractionController } from "./objects/ObjectInteractionController";
import { NoteEditor } from "./objects/NoteEditor";
import { hitTestObjects } from "./objects/objectHitTest";

/** How close the local avatar must be to a zone-less labeled seat (e.g. a
 *  hot-desk) before its name pops up — see nearbySeatStore.ts. Wider than
 *  hitTestSeats' own 28px click-to-sit default, since this is "you've
 *  arrived at your desk," not "your cursor is precisely on the chair." */
const SEAT_LABEL_RADIUS_PX = 70;

export interface PixiStageOptions {
  canvasContainer: HTMLDivElement;
  roomId: string;
  localUserId: string;
  initialLocalPosition: Point;
  /** The room's layout, decided on the room page by resolveRoomLayout (the same function the
   *  realtime server uses), so client and server always agree on the floor and the spawn point.
   *  Passed as the layout itself, not a name, because a company's own map has no name in the
   *  built-in list. */
  layout: RoomLayout;
  /** The workspace's own choice of flat or tilted (D20), resolved on the room page from
   *  getWorkspaceAppearance with the file's own default ("tilted") already applied — this class
   *  never reads the database itself. Fixed for the life of the stage; changing it takes a fresh
   *  page load, the same as a colour change (D18). */
  tilted: boolean;
}

/**
 * Owns every imperative object for one room: the Pixi Application, the
 * layer graph, the render ticker, the RealtimeClient socket, the
 * MovementController, the Viewport, and (Phase 7) canvas-object rendering
 * and interaction. Nothing here is React state — this class exists
 * precisely so RoomCanvas.tsx's effect can construct one of these and later
 * call `dispose()` on unmount, per the plan's rule that Socket.IO/Pixi/
 * other imperative SDK instances live in dedicated controllers, never in
 * normal React state.
 *
 * THE HARD RULE lives here: the ticker callback reads `peersStore`/
 * `objectsStore.getState()` directly (a plain object read, not a React
 * hook) and mutates Pixi display objects — it never touches React, so no
 * amount of position/drag traffic can cause a React re-render.
 */

export class PixiStage {
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly objectLayer = new Container();
  private readonly avatarLayer = new Container();
  private readonly avatars = new Map<string, Avatar>();
  private readonly objectViews = new Map<string, ObjectView>();
  private viewport!: Viewport;
  private movementController!: MovementController;
  private realtimeClient!: RealtimeClient;
  private objectInteraction!: ObjectInteractionController;
  private readonly noteEditor = new NoteEditor();
  private layout!: RoomLayout;
  private seatOverlay!: SeatOverlay;
  private floor!: FloorView;
  /** The floor's size in pixels, for "fit the whole map". */
  private floorSize = { width: 0, height: 0 };
  /** Which area the mouse is over and how high each area is raised (see lift.ts). Holds no timers. */
  private readonly lifts = new LiftState();
  private detachHover: (() => void) | null = null;
  // The map is fixed to the screen: any window resize fits it again, zoomed in or not.
  private readonly onRendererResize = (): void => {
    this.fitView();
  };
  private unsubscribeSnapshotWatch: (() => void) | null = null;
  private unsubscribeObjectsWatch: (() => void) | null = null;
  private unsubscribeSeatsWatch: (() => void) | null = null;
  private detachKeyboard: (() => void) | null = null;
  private detachObjectKeyboard: (() => void) | null = null;
  private detachDblClick: (() => void) | null = null;
  /** Lets the drawing loop rest when nothing changes and wakes it on activity (see idleGate.ts). */
  private gate!: IdleGate;
  private detachWake: (() => void) | null = null;
  private unsubscribePeersWake: (() => void) | null = null;
  private unsubscribeObjectsWake: (() => void) | null = null;
  private roomId!: string;
  private localUserId!: string;
  private disposed = false;
  /** The workspace's flat/tilted choice (D20), fixed for this stage's whole life. */
  private tilted = true;
  /** Whoever the mouse is currently over, for the name-visibility rule (D17, 5B). Set by
   *  attachHover, cleared on pointerleave and when the hovered avatar itself leaves. */
  private hoveredUserId: string | null = null;
  /** Whoever was last found through the people search (walkToPerson) — kept visible by name until
   *  another search result is chosen, they leave, or the person clicks the map themselves (D17, 5B). */
  private highlightedUserId: string | null = null;
  /** The zone-less labeled seat (e.g. a hot-desk) the local avatar is
   *  currently near, or null — see nearbySeatStore.ts's docs. Tracked here
   *  (not in the store) so the ticker can compare against the PREVIOUS
   *  frame's answer and only call nearbySeatStore.set() on an actual change. */
  private nearbySeatId: string | null = null;

  static async create(options: PixiStageOptions): Promise<PixiStage> {
    const stage = new PixiStage();
    await stage.init(options);
    return stage;
  }

  private async init(options: PixiStageOptions): Promise<void> {
    this.roomId = options.roomId;
    this.localUserId = options.localUserId;

    await this.app.init({
      resizeTo: options.canvasContainer,
      background: GROUND_CSS,
      antialias: true,
      // Pixi does not read the screen's real pixel density on its own (it defaults to a flat 1),
      // while the browser always draws DOM text at full sharpness regardless. On any screen above
      // 100% scaling (very common — a laptop's built-in display, most external monitors, any Mac),
      // that mismatch alone makes everything drawn on the canvas softer than a DOM element sitting
      // right next to it, worst on fine detail like small or tilted text (the owner's own catch,
      // comparing the map's "Focus Pods" label against the DOM chip of the same name, 2026-09-26).
      // autoDensity keeps the canvas the same on-screen SIZE while its internal pixel buffer grows
      // to match, so nothing else about layout or hit-testing changes.
      resolution: window.devicePixelRatio || 1,
      autoDensity: true,
      // Not started by Pixi: the IdleGate starts the loop when there is something to draw and stops it when
      // there is not, so a room with nobody moving asks the browser for no frames at all.
      autoStart: false,
    });
    // This screen does its own pointer handling (Viewport.ts and objectHitTest.ts) and deliberately uses none of
    // Pixi's pointer events. Pixi still starts a small clock of its own to keep those events fresh, which would ask
    // the browser for a frame about 60 times a second forever. Nothing here depends on it, so switch it off.
    EventsTicker.removeTickerListener();
    if (this.disposed) {
      // Unmounted while init() was still in flight — tear down immediately
      // rather than attaching a canvas nobody will ever see.
      this.app.destroy(true, { children: true });
      return;
    }
    options.canvasContainer.appendChild(this.app.canvas);

    this.objectInteraction = new ObjectInteractionController(options.localUserId, options.roomId, {
      onSendUpsert: (event) => this.realtimeClient.sendObjectUpsert(event),
      onSendDelete: (event) => this.realtimeClient.sendObjectDelete(event),
      getScale: () => this.viewport.getScale(),
    });

    // world carries the pan/zoom transform; overlay (added later, outside
    // world) would not scale with it. background -> floor furniture ->
    // objects -> avatars, per the plan's layer ordering — the floor is
    // static furniture built once from the layout (see FloorView.ts),
    // never touched by the per-frame render loop like avatars/objects are.
    this.tilted = options.tilted;
    this.viewport = new Viewport(
      this.app.canvas as HTMLCanvasElement,
      {
        onClickToWalk: (worldPoint) => {
          // A plain click means the person is choosing where to walk themselves, not following a
          // search result any more — the highlight (D17, 5B) belongs to search until they move on.
          this.highlightedUserId = null;
          this.movementController.moveTo(worldPoint, Date.now());
        },
        onObjectGestureStart: (worldPoint) => this.objectInteraction.handleGestureStart(worldPoint),
        onObjectGestureMove: (worldPoint) => this.objectInteraction.handleGestureMove(worldPoint),
        onObjectGestureEnd: () => this.objectInteraction.handleGestureEnd(),
        onFurnitureGestureStart: (worldPoint) => this.handleFurnitureGestureStart(worldPoint),
      },
      this.tilted,
    );
    this.world.addChild(this.viewport.world);

    // Already resolved (with the server's own fallback rule) by the room page.
    this.layout = options.layout;
    const movementConfig = movementConfigForLayout(this.layout, DEFAULT_MOVEMENT_CONFIG);

    this.viewport.world.addChild(createBackground(movementConfig));
    this.floor = buildFloorView(this.layout, this.tilted);
    this.viewport.world.addChild(this.floor.container);
    this.seatOverlay = new SeatOverlay(this.layout, this.floor.plan, this.tilted);
    this.viewport.world.addChild(this.seatOverlay.container);
    this.objectLayer.sortableChildren = true;
    this.viewport.world.addChild(this.objectLayer);
    this.viewport.world.addChild(this.avatarLayer);
    this.app.stage.addChild(this.world);
    // Show the whole floor, centred, when the room opens.
    this.floorSize = { width: movementConfig.roomWidthPx, height: movementConfig.roomHeightPx };
    // Not fitView(): that also wakes the drawing loop, which does not exist yet at this point in start-up.
    this.viewport.fitToFloor(this.floorSize, {
      width: this.app.screen.width,
      height: this.app.screen.height,
    });
    // Pixi's own internal clock (Ticker.system, used for its memory clean-up chores) rests and wakes with ours.
    this.gate = new IdleGate(tickerGroup(this.app.ticker, Ticker.system));

    this.movementController = new MovementController(
      options.initialLocalPosition,
      {
        onLocalPositionChanged: (position) => peersStore.getState().setLocalPosition(position),
        onSendMove: (position) => this.realtimeClient.sendMove({ position, clientTs: Date.now() }),
        onTeleport: (position) => this.realtimeClient.sendMoveTo({ position }),
        // Fires after `seated` has already flipped false and movement has
        // already resumed for this frame (see MovementController's
        // standUp docs) — this is purely "tell the server", never a gate
        // on standing up itself.
        onStandUp: () => this.realtimeClient.sendSeatRelease(),
      },
      movementConfig,
    );
    // The note text editor is an HTML <textarea> overlaid on the canvas
    // (see NoteEditor.ts) — without this guard, typing "w"/"a"/"s"/"d"
    // while editing a note would also walk the avatar out from under the
    // user, since attachKeyboard listens on `window`.
    this.detachKeyboard = this.movementController.attachKeyboard(window, () => this.noteEditor.isOpen());

    this.realtimeClient = new RealtimeClient(options.roomId, options.localUserId, {
      onMoveCorrection: (position) => this.movementController.applyCorrection(position),
    });

    // Reconcile avatar display objects whenever the roster's membership
    // changes (join/leave) — NOT on every position tick. This subscription
    // uses subscribeWithSelector so it only fires when the set of peer ids
    // actually changes, keeping it far below per-frame frequency.
    this.unsubscribeSnapshotWatch = peersStore.subscribe(
      (state) => Array.from(state.peers.keys()).sort().join(","),
      () => this.reconcileAvatars(peersStore.getState()),
    );
    this.reconcileAvatars(peersStore.getState());

    // Same pattern for objects: reconcile ObjectView instances only when
    // the SET of object ids changes (create/delete), never on every
    // drag/resize frame — that traffic is handled entirely in renderFrame
    // below, reading render rects directly with no store subscription at all.
    this.unsubscribeObjectsWatch = objectsStore.subscribe(
      (state) => Array.from(state.objects.keys()).sort().join(","),
      () => this.reconcileObjectViews(objectsStore.getState()),
    );
    this.reconcileObjectViews(objectsStore.getState());

    // Seat occupancy changes at join/leave/sit/stand frequency, never per
    // frame — a store subscription (not the render loop) drives both the
    // chair tint (SeatOverlay) and the seated ring on the owning avatar.
    this.unsubscribeSeatsWatch = seatsStore.subscribe(
      (state) => state.occupancy,
      (occupancy) => {
        this.seatOverlay.update(occupancy);
        this.updateSeatedAvatars(occupancy);
        this.gate.wake();
      },
    );
    // Anyone moving, joining or leaving, and any object change, may need drawing. These fire at network speed
    // (about ten times a second), never per frame, and only wake the loop; they draw nothing themselves.
    this.unsubscribePeersWake = peersStore.subscribe(() => this.gate.wake());
    this.unsubscribeObjectsWake = objectsStore.subscribe(() => this.gate.wake());
    this.seatOverlay.update(seatsStore.getState().occupancy);

    this.detachObjectKeyboard = this.attachObjectKeyboard(window);
    this.detachDblClick = this.attachDoubleClick(this.app.canvas as HTMLCanvasElement);
    this.detachHover = this.attachHover(this.app.canvas as HTMLCanvasElement);
    // The window (and so the drawing area) changed size: keep showing the whole map, unless the person has zoomed or
    // moved the view themselves. Pixi announces this after it has resized the canvas, so `app.screen` is already new.
    this.app.renderer.on("resize", this.onRendererResize);

    this.app.ticker.add((ticker) => {
      const dtSeconds = ticker.deltaMS / 1000;
      const now = Date.now();
      this.movementController.update(dtSeconds, now);
      const stillChanging = this.renderFrame(dtSeconds);
      // Rest after a few quiet frames; anything that happens later wakes the loop again (see idleGate.ts).
      this.gate.frameDone(stillChanging || this.movementController.needsFrames());
    });
    this.detachWake = wakeOnActivity(this.gate, {
      window,
      canvas: this.app.canvas as HTMLCanvasElement,
      document,
    });
    this.gate.wake(); // draw the first frame

    await this.realtimeClient.connect();
  }

  /** Creates/destroys Avatar display objects to match the current roster.
   *  Cheap and infrequent (join/leave only) — never called from the ticker. */
  private reconcileAvatars(state: PeersState): void {
    for (const [userId, peer] of state.peers) {
      let avatar = this.avatars.get(userId);
      if (!avatar) {
        avatar = new Avatar(peer.name, peer.isLocal, this.tilted);
        this.avatars.set(userId, avatar);
        this.avatarLayer.addChild(avatar.container);
      } else {
        avatar.setName(peer.name);
      }
    }

    for (const [userId, avatar] of this.avatars) {
      if (!state.peers.has(userId)) {
        avatar.destroy();
        this.avatars.delete(userId);
        // Their name-visibility state (D17, 5B) leaves with them, so a later join reusing no id
        // never inherits a stale hover/highlight that meant someone else.
        if (this.hoveredUserId === userId) this.hoveredUserId = null;
        if (this.highlightedUserId === userId) this.highlightedUserId = null;
      }
    }

    // A newly-joined avatar may already be seated per seats:snapshot — this
    // keeps a fresh avatar's ring correct without waiting for the next
    // unrelated seat change.
    this.updateSeatedAvatars(seatsStore.getState().occupancy);
  }

  /** Toggles each avatar's seated ring from current occupancy — called on
   *  every seatsStore change and on avatar reconciliation, never per frame. */
  private updateSeatedAvatars(occupancy: ReadonlyMap<string, string>): void {
    const seatedUserIds = new Set(occupancy.values());
    for (const [userId, avatar] of this.avatars) {
      avatar.setSeated(seatedUserIds.has(userId));
    }
  }

  /** Viewport's onFurnitureGestureStart — a hit on a seat claims the
   *  gesture (so it doesn't also become a click-to-walk) and fires the
   *  claim asynchronously; the local avatar only teleports on an accepted
   *  ack (sit-down waits for it — see RealtimeClient.sendSeatClaim's docs),
   *  unlike standing up, which is optimistic. A miss returns false and
   *  falls through to the normal click-to-walk/pan arbitration. */
  private handleFurnitureGestureStart(worldPoint: Point): boolean {
    const seat = hitTestSeats(this.layout, worldPoint);
    if (seat) {
      void this.realtimeClient.sendSeatClaim(seat.id).then((result) => {
        if (result.ok) this.movementController.applyTeleport(seat.anchor);
        else seatFeedbackStore.getState().show(result.error);
      });
      return true;
    }

    // A click that misses every chair's own small hit radius but lands on
    // the shared desk/table surface itself: "sit anywhere free at this
    // table" (Part 4B's auto-seat-within-table strategy), rather than
    // falling through to click-to-walk onto furniture. Off by default for
    // every workspace today (see WorkspaceSeatingConfig's docs — no admin
    // UI exists yet to enable it), so this currently surfaces a
    // "not_enabled" toast rather than seating anyone; the request/response
    // plumbing is real and ready for when that admin setting exists.
    const furniture = furnitureAt(this.layout, worldPoint);
    if (!furniture) return false;

    void this.realtimeClient
      .sendSeatSelect({ strategy: "autoSeatWithinTable", target: { point: worldPoint } })
      .then((result) => {
        if (result.outcome === "seated") {
          const anchor = this.layout.seats.find((s) => s.id === result.seatId)?.anchor;
          if (anchor) this.movementController.applyTeleport(anchor);
        } else {
          seatFeedbackStore.getState().show(result.reason);
        }
      });
    return true;
  }

  /** Creates/destroys ObjectView instances to match the current object set.
   *  Cheap and infrequent (create/delete only) — never called from the
   *  ticker; per-frame position/size updates happen in renderFrame via
   *  each view's own update(), not by recreating views. */
  private reconcileObjectViews(state: ObjectsState): void {
    for (const [objectId] of state.objects) {
      if (!this.objectViews.has(objectId)) {
        const view = new ObjectView(objectId);
        this.objectViews.set(objectId, view);
        this.objectLayer.addChild(view.container);
      }
    }

    for (const [objectId, view] of this.objectViews) {
      if (!state.objects.has(objectId)) {
        view.destroy();
        this.objectViews.delete(objectId);
      }
    }
  }

  /** Puts a person at their floor position, raised along with the plate they are standing on. */
  private placeAvatar(avatar: Avatar, position: Point): void {
    if (this.lifts.isActive()) {
      const slab = slabAt(this.floor.plan, position);
      const height = slab ? this.lifts.liftOf(slab.id) : 0;
      if (height > 0) {
        const step = liftVector(height, this.tilted);
        avatar.setPosition(position.x + step.x, position.y + step.y);
        return;
      }
    }
    avatar.setPosition(position.x, position.y);
  }

  /** Which peer (if any) is under this screen point, within AVATAR_HOVER_RADIUS scaled by the
   *  current zoom (dots grow and shrink with zoom, so the hit area does too) — D17, decision 5B: the
   *  person under the mouse gets their name shown. Picks the nearest one within range, screen-space,
   *  not floor-space, since that is what "under the mouse" actually means to the person looking. */
  /** Updates nearbySeatStore from a world-space point (either the local
   *  avatar's renderPosition, per frame, or the mouse's floor-space position,
   *  per pointermove — see the two call sites) — only writes to the store
   *  when the answer actually changes. Cosmetic-only hot-desk name popup for
   *  a zone-less labeled seat; see nearbySeatStore.ts's docs. */
  private updateNearbySeatFrom(worldPoint: Point): void {
    const nearSeat = hitTestSeats(this.layout, worldPoint, SEAT_LABEL_RADIUS_PX);
    const nextNearbySeatId = nearSeat && nearSeat.zoneId === undefined ? nearSeat.id : null;
    if (nextNearbySeatId !== this.nearbySeatId) {
      this.nearbySeatId = nextNearbySeatId;
      nearbySeatStore.getState().set(nearSeat && nextNearbySeatId ? { seatId: nearSeat.id, label: nearSeat.label } : null);
    }
  }

  private avatarUnderScreenPoint(screenPoint: Point): string | null {
    const hitRadius = AVATAR_HOVER_RADIUS * this.viewport.getScale();
    let nearestUserId: string | null = null;
    let nearestDistSq = hitRadius * hitRadius;
    for (const [userId, peer] of peersStore.getState().peers) {
      const onScreen = this.viewport.worldToScreen(peer.renderPosition);
      const dx = onScreen.x - screenPoint.x;
      const dy = onScreen.y - screenPoint.y;
      const distSq = dx * dx + dy * dy;
      if (distSq <= nearestDistSq) {
        nearestDistSq = distSq;
        nearestUserId = userId;
      }
    }
    return nearestUserId;
  }

  /** Raises the plate under the mouse, and (D17, 5B) tracks which avatar is under the mouse for the
   *  name-visibility rule. Moving the mouse without crossing onto another plate or a different
   *  avatar changes nothing, and only a real change wakes the drawing loop. */
  private attachHover(canvas: HTMLCanvasElement): () => void {
    const onMove = (e: PointerEvent) => {
      if (e.buttons) return; // dragging or panning, not hovering
      const rect = canvas.getBoundingClientRect();
      const screenPoint = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      let woke = false;

      const floorPoint = this.viewport.screenToWorld(screenPoint);
      const currentSlab = this.lifts.hoveredId();
      const nextSlab = pickSlab(this.floor.plan, floorPoint, currentSlab ? { slabId: currentSlab, lift: this.lifts.liftOf(currentSlab) } : null, this.tilted);
      if (nextSlab !== currentSlab) {
        this.lifts.setHovered(nextSlab);
        this.seatOverlay.showFreeOn(nextSlab);
        woke = true;
      }

      const nextHovered = this.avatarUnderScreenPoint(screenPoint);
      if (nextHovered !== this.hoveredUserId) {
        this.hoveredUserId = nextHovered;
        woke = true;
      }

      // Same "mouse near it -> name shows" behavior as hovering an avatar,
      // for a zone-less labeled seat (a hot-desk) — see nearbySeatStore.ts.
      this.updateNearbySeatFrom(floorPoint);

      if (woke) this.gate.wake();
    };
    const onLeave = () => {
      let woke = false;
      if (this.lifts.hoveredId() !== null) {
        this.lifts.setHovered(null);
        this.seatOverlay.showFreeOn(null);
        woke = true;
      }
      if (this.hoveredUserId !== null) {
        this.hoveredUserId = null;
        woke = true;
      }
      if (woke) this.gate.wake();
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerleave", onLeave);
    return () => {
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerleave", onLeave);
    };
  }

  /** Runs every ticker frame. Reads the stores directly via getState() —
   *  never via a React hook — and mutates Pixi display objects in place.
   *  This is the loop the "React must never re-render on movement/drag"
   *  rule protects: nothing here can trigger a component render.
   *  Returns whether anything is still moving toward its target, so the
   *  IdleGate knows when the loop can rest. */
  private renderFrame(dtSeconds: number): boolean {
    let stillChanging = false;

    // Plates rising or settling back under the mouse. Busy only while something is actually moving, so a mouse resting
    // on a raised area costs no frames at all.
    const moved = this.lifts.step(dtSeconds);
    for (const slabId of moved) {
      const height = this.lifts.liftOf(slabId);
      this.floor.setLift(slabId, height);
      this.seatOverlay.liftSlab(slabId, liftVector(height, this.tilted));
      stillChanging = true;
    }

    const peers = peersStore.getState();

    for (const [userId, peer] of peers.peers) {
      const avatar = this.avatars.get(userId);
      if (!avatar) continue;

      if (peer.isLocal) {
        // Local avatar renders immediately at its authoritative position —
        // no smoothing, since it already reflects live input, not a
        // network round trip.
        this.placeAvatar(avatar, peer.renderPosition);
        // Cosmetic-only hot-desk name popup, mirrored by mouse hover in
        // attachHover — see nearbySeatStore.ts's docs.
        this.updateNearbySeatFrom(peer.renderPosition);
        continue;
      }

      // Remote avatars snap directly to the latest server-reported position —
      // no stepToward smoothing — per the owner's explicit choice to trade
      // gliding motion for instant sync (also removes the continuous sweep
      // across many small desk plates that caused cascading rises). Mutate
      // in place: renderPosition is intentionally not replaced via
      // store.setState (see peersStore.ts) so this never notifies any
      // subscriber, React or otherwise.
      if (peer.renderPosition.x !== peer.position.x || peer.renderPosition.y !== peer.position.y) {
        peer.renderPosition.x = peer.position.x;
        peer.renderPosition.y = peer.position.y;
      }
      this.placeAvatar(avatar, peer.renderPosition);
    }

    // D17, 5B: recompute who gets a shown name this frame. Cheap (one pass over peers.peers, which
    // the loop above already walks) and correct even while nothing moves, since "nearby" changes as
    // soon as any renderPosition above did.
    if (peers.localUserId) {
      const positions = new Map<string, Point>();
      for (const [userId, peer] of peers.peers) positions.set(userId, peer.renderPosition);
      const shown = computeNameVisibility({
        positions,
        localUserId: peers.localUserId,
        nearbyRadiusPx: DEFAULT_PROXIMITY_CONFIG.videoRadiusPx,
        hoveredUserId: this.hoveredUserId,
        highlightedUserId: this.highlightedUserId,
      });
      for (const [userId, avatar] of this.avatars) avatar.setNameVisible(shown.has(userId));
    }

    const objects = objectsStore.getState();
    for (const [objectId, record] of objects.objects) {
      const view = this.objectViews.get(objectId);
      if (!view) continue;

      // The object WE are actively dragging/resizing tracks the pointer
      // immediately (applyLocalEdit already wrote the exact rect) — no
      // smoothing, same local/remote split renderFrame uses for avatars.
      // Everything else converges toward its authoritative rect.
      if (record.locallyDirty) {
        stillChanging = true;
      } else {
        const target = { x: record.state.x, y: record.state.y, width: record.state.width, height: record.state.height };
        if (
          Math.abs(record.render.x - target.x) > 0.05 ||
          Math.abs(record.render.y - target.y) > 0.05 ||
          Math.abs(record.render.width - target.width) > 0.05 ||
          Math.abs(record.render.height - target.height) > 0.05
        ) {
          record.render.x = stepScalarToward(record.render.x, target.x, dtSeconds);
          record.render.y = stepScalarToward(record.render.y, target.y, dtSeconds);
          record.render.width = stepScalarToward(record.render.width, target.width, dtSeconds);
          record.render.height = stepScalarToward(record.render.height, target.height, dtSeconds);
          stillChanging = true;
        }
      }

      view.update(
        record.state,
        record.render,
        objects.selectedId === objectId,
      );
    }
    return stillChanging;
  }

  /** Delete/Backspace deletes the current selection; Escape deselects.
   *  Skipped entirely while the note editor is open — the editor has its
   *  own Escape handling (cancel the edit) and Delete/Backspace must type
   *  normally into the textarea, not delete the object out from under it. */
  private attachObjectKeyboard(target: EventTarget): () => void {
    const onKeyDown = (e: Event) => {
      if (this.noteEditor.isOpen()) return;
      const key = (e as KeyboardEvent).key;
      if (key === "Delete" || key === "Backspace") {
        if (objectsStore.getState().selectedId) {
          e.preventDefault();
          this.objectInteraction.deleteSelected();
        }
      } else if (key === "Escape") {
        this.objectInteraction.deselect();
      }
    };
    target.addEventListener("keydown", onKeyDown);
    return () => target.removeEventListener("keydown", onKeyDown);
  }

  /** Double-click a note opens its text editor. A separate native listener
   *  rather than routing through Viewport's pan/click-to-walk arbitration —
   *  double-click is an independent gesture, not a member of that table. */
  private attachDoubleClick(canvas: HTMLCanvasElement): () => void {
    const onDblClick = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const worldPoint = this.viewport.screenToWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      const state = objectsStore.getState();

      const candidates = Array.from(state.objects.values()).map((r) => ({
        objectId: r.state.objectId,
        ...r.render,
        z: r.state.z,
      }));
      const hitId = hitTestObjects(candidates, worldPoint);
      if (!hitId) return;

      const record = state.objects.get(hitId);
      if (!record || record.state.type !== "note") return;

      this.openNoteEditor(record.state.objectId);
    };
    canvas.addEventListener("dblclick", onDblClick);
    return () => canvas.removeEventListener("dblclick", onDblClick);
  }

  private openNoteEditor(objectId: string): void {
    const record = objectsStore.getState().objects.get(objectId);
    if (!record) return;

    // Notes lie flat on the tilted floor, so the editor box is centred on where the note's middle appears.
    const scale = this.viewport.getScale();
    const width = record.render.width * scale;
    const height = record.render.height * scale;
    const centreScreen = this.viewport.worldToScreen({
      x: record.render.x + record.render.width / 2,
      y: record.render.y + record.render.height / 2,
    });
    const initialText = typeof record.state.data.text === "string" ? record.state.data.text : "";

    this.noteEditor.open(
      this.app.canvas.parentElement ?? document.body,
      {
        x: centreScreen.x - width / 2,
        y: centreScreen.y - height / 2,
        width,
        height,
      },
      initialText,
      (text) => {
        const current = objectsStore.getState().objects.get(objectId);
        if (!current) return;
        const nextData = { ...current.state.data, text };
        objectsStore.getState().applyLocalEdit(objectId, current.render);
        this.realtimeClient.sendObjectUpsert({
          objectId,
          roomId: this.roomId,
          type: current.state.type,
          x: current.state.x,
          y: current.state.y,
          width: current.state.width,
          height: current.state.height,
          rotation: current.state.rotation,
          z: current.state.z,
          data: nextData,
          baseVersion: current.state.version,
        });
      },
    );
  }

  /** Zooms in (factor above 1) or out (below 1) around the middle of the screen. For the zoom buttons. */
  zoomBy(factor: number): void {
    this.viewport.zoomAt({ x: this.app.screen.width / 2, y: this.app.screen.height / 2 }, factor);
    this.gate.wake();
  }

  /** Shows the whole floor again, centred. For the "fit" button. */
  fitView(): void {
    this.viewport.fitToFloor(this.floorSize, {
      width: this.app.screen.width,
      height: this.app.screen.height,
    });
    this.gate.wake();
  }

  /** Walks the local person to where another person is standing. For the people search. Does nothing for an unknown
   *  or the local person. */
  walkToPerson(userId: string): void {
    const peer = peersStore.getState().peers.get(userId);
    if (!peer || peer.isLocal) return;
    // D17, 5B: found through search, so their name stays shown until another search result is
    // chosen, they leave, or the person clicks the map themselves (see onClickToWalk).
    this.highlightedUserId = userId;
    this.movementController.moveTo({ x: peer.position.x, y: peer.position.y }, Date.now());
    this.gate.wake();
  }

  /** Walks the local person to the middle of a named area. For the areas list in the room bar (which
   *  replaces drawing area names on the map itself — 2026-09-26: text tilted with the floor could
   *  never read as crisp as flat text at this size, so the names moved into a plain list instead).
   *  Does nothing for an unknown zone id. */
  walkToZone(zoneId: string): void {
    const zone = zoneById(this.layout, zoneId);
    if (!zone) return;
    this.movementController.moveTo(tileRectCenter(zone.rect), Date.now());
    this.gate.wake();
  }

  /** Creates a new object centered in the current viewport, for the
   *  toolbar UI (see components/ObjectToolbar.tsx) — kept here rather than
   *  exposing the interaction controller directly, matching how RoomCanvas
   *  never exposes PixiStage/RealtimeClient internals to React either. */
  createObjectAtViewCenter(type: Parameters<ObjectInteractionController["createObject"]>[0], data: Record<string, unknown>): void {
    const screenCenter = {
      x: this.app.canvas.width / (this.app.renderer.resolution * 2),
      y: this.app.canvas.height / (this.app.renderer.resolution * 2),
    };
    const worldPoint = this.viewport.screenToWorld(screenCenter);
    this.objectInteraction.createObject(type, worldPoint, data);
  }

  /** Deletes the current selection — the toolbar UI's Delete button calls
   *  this rather than reaching into the interaction controller directly,
   *  same "React never touches the imperative object" pattern as
   *  createObjectAtViewCenter above. */
  deleteSelectedObject(): void {
    this.objectInteraction.deleteSelected();
  }

  /** The capacity screen's "Try again" button calls this — same
   *  never-expose-the-client-directly pattern as the two methods above. */
  retryJoin(): void {
    this.realtimeClient.retryJoin();
  }

  dispose(): void {
    this.disposed = true;
    nearbySeatStore.getState().set(null);
    this.detachKeyboard?.();
    this.detachObjectKeyboard?.();
    this.detachDblClick?.();
    this.detachHover?.();
    this.app.renderer?.off("resize", this.onRendererResize);
    this.detachWake?.();
    this.noteEditor.dispose();
    this.unsubscribeSnapshotWatch?.();
    this.unsubscribeObjectsWatch?.();
    this.unsubscribeSeatsWatch?.();
    this.unsubscribePeersWake?.();
    this.unsubscribeObjectsWake?.();
    // Leave Pixi's shared internal clock as we found it: it may have been put to sleep while the room rested.
    Ticker.system.start();
    this.realtimeClient?.dispose();
    this.viewport?.dispose();
    for (const avatar of this.avatars.values()) avatar.destroy();
    this.avatars.clear();
    for (const view of this.objectViews.values()) view.destroy();
    this.objectViews.clear();
    this.seatOverlay?.destroy();
    // app.canvas may not exist yet if disposed mid-init; app.destroy handles
    // removing ticker callbacks and the renderer regardless.
    this.app.destroy(true, { children: true });
  }
}
