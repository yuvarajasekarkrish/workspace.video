"use client";

import { useCallback, useEffect, useRef } from "react";
import type { Point, CanvasObjectType, RoomLayout } from "@workspace-video/shared";
import { PixiStage } from "@/canvas/PixiStage";
import { SpatialAudioController } from "@/audio/SpatialAudioController";
import { ConnectionBadge } from "./ConnectionBadge";
import { OccupancyBadge } from "./OccupancyBadge";
import { CapacityScreen } from "./CapacityScreen";
import { RoomHud } from "./RoomHud";
import { RoomDock } from "./RoomDock";
import { ZoomControls } from "./ZoomControls";
import { ObjectToolbar } from "./ObjectToolbar";
import { ZoneToast } from "./ZoneToast";
import { ZoneHudChip } from "./ZoneHudChip";

export interface RoomCanvasProps {
  roomId: string;
  localUserId: string;
  initialLocalPosition: Point;
  /** The room's layout itself (decided on the room page), not a name to look up. */
  layout: RoomLayout;
  /** The workspace's flat-or-tilted choice (D20), already resolved on the room page with the
   *  file's own default ("tilted") applied. */
  tilted: boolean;
}

/** How much one press of a zoom button zooms. */
const ZOOM_STEP = 1.25;

async function fetchLiveKitToken(roomId: string) {
  const res = await fetch(`/api/rooms/${encodeURIComponent(roomId)}/livekit-token`);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error ?? `LiveKit token request failed (${res.status}).`);
  }
  return res.json();
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
 *
 * SpatialAudioController is mounted as a SIBLING of PixiStage, in its own
 * effect with its own cleanup, per the approved LiveKit plan — canvas and
 * audio fail and dispose independently, and audio has no dependency on the
 * Pixi Application existing at all.
 */
export function RoomCanvas({ roomId, localUserId, initialLocalPosition, layout, tilted }: RoomCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const audioControllerRef = useRef<SpatialAudioController | null>(null);
  const stageRef = useRef<PixiStage | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let stage: PixiStage | null = null;

    PixiStage.create({ canvasContainer: container, roomId, localUserId, initialLocalPosition, layout, tilted }).then(
      (created) => {
        if (cancelled) {
          created.dispose();
          return;
        }
        stage = created;
        stageRef.current = created;
      },
    );

    return () => {
      cancelled = true;
      stageRef.current = null;
      stage?.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initialLocalPosition/layout/tilted are intentionally one-shot seeds, not reactive dependencies
  }, [roomId, localUserId]);

  useEffect(() => {
    const controller = new SpatialAudioController(roomId, localUserId, () => fetchLiveKitToken(roomId));
    audioControllerRef.current = controller;
    void controller.connect();

    return () => {
      audioControllerRef.current = null;
      void controller.dispose();
    };
  }, [roomId, localUserId]);

  const handleEnableAudio = useCallback(() => {
    void audioControllerRef.current?.enableAudio();
  }, []);

  const handleToggleMute = useCallback((muted: boolean) => {
    void audioControllerRef.current?.setMuted(muted);
  }, []);

  const handleGoToPerson = useCallback((userId: string) => {
    stageRef.current?.walkToPerson(userId);
  }, []);

  const handleZoomIn = useCallback(() => stageRef.current?.zoomBy(ZOOM_STEP), []);
  const handleZoomOut = useCallback(() => stageRef.current?.zoomBy(1 / ZOOM_STEP), []);
  const handleFit = useCallback(() => stageRef.current?.fitView(), []);

  const handleCreateObject = useCallback((type: CanvasObjectType, data: Record<string, unknown>) => {
    stageRef.current?.createObjectAtViewCenter(type, data);
  }, []);

  const handleDeleteSelected = useCallback(() => {
    stageRef.current?.deleteSelectedObject();
  }, []);

  const handleRetryJoin = useCallback(() => {
    stageRef.current?.retryJoin();
  }, []);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full" />
      <ConnectionBadge />
      <OccupancyBadge />
      <ZoneHudChip layout={layout} />
      <ZoneToast />
      <RoomHud />
      <RoomDock onEnableAudio={handleEnableAudio} onToggleMute={handleToggleMute} onGoToPerson={handleGoToPerson} />
      <ZoomControls onZoomIn={handleZoomIn} onZoomOut={handleZoomOut} onFit={handleFit} />
      <ObjectToolbar localUserId={localUserId} onCreate={handleCreateObject} onDeleteSelected={handleDeleteSelected} />
      <CapacityScreen onRetry={handleRetryJoin} />
    </div>
  );
}
