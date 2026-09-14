import { Application, Container } from "pixi.js";
import type { Point } from "@cosmos/shared";
import { peersStore, type PeersState } from "@/store/peersStore";
import { createBackground } from "./Background";
import { Avatar } from "./Avatar";
import { Viewport } from "./Viewport";
import { stepToward, hasConverged } from "./interpolation";
import { MovementController } from "@/input/MovementController";
import { RealtimeClient } from "@/net/RealtimeClient";

export interface PixiStageOptions {
  canvasContainer: HTMLDivElement;
  roomId: string;
  localUserId: string;
  initialLocalPosition: Point;
}

/**
 * Owns every imperative object for one room: the Pixi Application, the
 * layer graph, the render ticker, the RealtimeClient socket, the
 * MovementController, and the Viewport. Nothing here is React state —
 * this class exists precisely so RoomCanvas.tsx's effect can construct one
 * of these and later call `dispose()` on unmount, per the plan's rule that
 * Socket.IO/Pixi/other imperative SDK objects live in dedicated
 * controllers, never in normal React state.
 *
 * THE HARD RULE lives here: the ticker callback reads `peersStore.getState()`
 * directly (a plain object read, not a React hook) and mutates Pixi display
 * objects — it never touches React, so no amount of position traffic can
 * cause a React re-render.
 */
export class PixiStage {
  private readonly app = new Application();
  private readonly world = new Container();
  private readonly avatarLayer = new Container();
  private readonly avatars = new Map<string, Avatar>();
  private viewport!: Viewport;
  private movementController!: MovementController;
  private realtimeClient!: RealtimeClient;
  private unsubscribeSnapshotWatch: (() => void) | null = null;
  private detachKeyboard: (() => void) | null = null;
  private disposed = false;

  static async create(options: PixiStageOptions): Promise<PixiStage> {
    const stage = new PixiStage();
    await stage.init(options);
    return stage;
  }

  private async init(options: PixiStageOptions): Promise<void> {
    await this.app.init({
      resizeTo: options.canvasContainer,
      background: "#0b0d12",
      antialias: true,
    });
    if (this.disposed) {
      // Unmounted while init() was still in flight — tear down immediately
      // rather than attaching a canvas nobody will ever see.
      this.app.destroy(true, { children: true });
      return;
    }
    options.canvasContainer.appendChild(this.app.canvas);

    // world carries the pan/zoom transform; overlay (added later, outside
    // world) would not scale with it. background -> objects placeholder ->
    // avatars, per the plan's layer ordering.
    this.viewport = new Viewport(this.app.canvas as HTMLCanvasElement, {
      onClickToWalk: (worldPoint) => this.movementController.setWalkTarget(worldPoint),
    });
    this.world.addChild(this.viewport.world);
    this.viewport.world.addChild(createBackground());
    this.viewport.world.addChild(new Container()); // objects placeholder (phase 7)
    this.viewport.world.addChild(this.avatarLayer);
    this.app.stage.addChild(this.world);

    this.movementController = new MovementController(options.initialLocalPosition, {
      onLocalPositionChanged: (position) => peersStore.getState().setLocalPosition(position),
      onSendMove: (position) => this.realtimeClient.sendMove({ position, clientTs: Date.now() }),
    });
    this.detachKeyboard = this.movementController.attachKeyboard(window);

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

    this.app.ticker.add((ticker) => {
      const dtSeconds = ticker.deltaMS / 1000;
      const now = Date.now();
      this.movementController.update(dtSeconds, now);
      this.renderFrame(dtSeconds);
    });

    await this.realtimeClient.connect();
  }

  /** Creates/destroys Avatar display objects to match the current roster.
   *  Cheap and infrequent (join/leave only) — never called from the ticker. */
  private reconcileAvatars(state: PeersState): void {
    for (const [userId, peer] of state.peers) {
      let avatar = this.avatars.get(userId);
      if (!avatar) {
        avatar = new Avatar(peer.name, peer.isLocal);
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
      }
    }
  }

  /** Runs every ticker frame. Reads the store directly via getState() —
   *  never via a React hook — and mutates Pixi display objects in place.
   *  This is the loop the "React must never re-render on movement" rule
   *  protects: nothing here can trigger a component render. */
  private renderFrame(dtSeconds: number): void {
    const state = peersStore.getState();

    for (const [userId, peer] of state.peers) {
      const avatar = this.avatars.get(userId);
      if (!avatar) continue;

      if (peer.isLocal) {
        // Local avatar renders immediately at its authoritative position —
        // no smoothing, since it already reflects live input, not a
        // network round trip.
        avatar.setPosition(peer.renderPosition.x, peer.renderPosition.y);
        continue;
      }

      if (!hasConverged(peer.renderPosition, peer.position)) {
        const next = stepToward(peer.renderPosition, peer.position, dtSeconds);
        // Mutate in place: renderPosition is intentionally not replaced via
        // store.setState (see peersStore.ts) so this per-frame update never
        // notifies any subscriber, React or otherwise.
        peer.renderPosition.x = next.x;
        peer.renderPosition.y = next.y;
      }
      avatar.setPosition(peer.renderPosition.x, peer.renderPosition.y);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.detachKeyboard?.();
    this.unsubscribeSnapshotWatch?.();
    this.realtimeClient?.dispose();
    this.viewport?.dispose();
    for (const avatar of this.avatars.values()) avatar.destroy();
    this.avatars.clear();
    // app.canvas may not exist yet if disposed mid-init; app.destroy handles
    // removing ticker callbacks and the renderer regardless.
    this.app.destroy(true, { children: true });
  }
}
