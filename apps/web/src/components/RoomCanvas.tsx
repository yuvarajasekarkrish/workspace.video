"use client";

import { useEffect, useRef } from "react";
import type { Point } from "@cosmos/shared";
import { PixiStage } from "@/canvas/PixiStage";
import { ConnectionBadge } from "./ConnectionBadge";
import { RoomHud } from "./RoomHud";

export interface RoomCanvasProps {
  roomId: string;
  localUserId: string;
  initialLocalPosition: Point;
}

/**
 * Mounts a PixiStage in an effect and disposes it on cleanup. This
 * component intentionally holds no per-frame state — everything that
 * changes on movement lives in PixiStage/peersStore, read imperatively.
 * React only re-renders here on mount/unmount and on the (rare) roomId
 * change, never as a side effect of anything the ticker does.
 *
 * React 19 StrictMode double-invokes effects in dev, and a partial teardown
 * is invisible until you navigate away and back — see PixiStage.dispose()
 * for the checklist (socket, ticker, DOM listeners, store subscriptions,
 * the Pixi Application itself). The cancellation flag below additionally
 * guards the case where StrictMode's cleanup runs while `PixiStage.create`
 * is still awaiting `app.init()`.
 */
export function RoomCanvas({ roomId, localUserId, initialLocalPosition }: RoomCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let stage: PixiStage | null = null;

    PixiStage.create({ canvasContainer: container, roomId, localUserId, initialLocalPosition }).then(
      (created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        stage = created;
      },
    );

    return () => {
      cancelled = true;
      stage?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialLocalPosition is intentionally a one-shot seed, not a reactive dependency
  }, [roomId, localUserId]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <ConnectionBadge />
      <RoomHud />
    </div>
  );
}
