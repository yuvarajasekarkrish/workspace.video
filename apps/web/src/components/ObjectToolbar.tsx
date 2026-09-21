"use client";

import { useState } from "react";
import type { CanvasObjectType } from "@workspace-video/shared";
import { useSelectedObject } from "@/store/objectsStore";

export interface ObjectToolbarProps {
  localUserId: string;
  onCreate: (type: CanvasObjectType, data: Record<string, unknown>) => void;
  onDeleteSelected: () => void;
}

/**
 * Minimal object-creation UI. Subscribes only to useSelectedObject (human-
 * timescale selection identity, never coordinates — see objectsStore.ts's
 * hard-rule docs), and calls back into PixiStage's
 * createObjectAtViewCenter/ObjectInteractionController for the actual
 * imperative work, matching RoomDock's relationship to
 * SpatialAudioController: React never holds the imperative object itself.
 */
export function ObjectToolbar({ localUserId, onCreate, onDeleteSelected }: ObjectToolbarProps) {
  const selected = useSelectedObject(localUserId);
  const [imageUrl, setImageUrl] = useState("");
  const [showImagePrompt, setShowImagePrompt] = useState(false);

  function handleAddImage() {
    if (!imageUrl.trim()) return;
    onCreate("image", { url: imageUrl.trim() });
    setImageUrl("");
    setShowImagePrompt(false);
  }

  return (
    <div className="flex flex-col items-end gap-2 text-base">
      <div className="flex flex-wrap items-center justify-end gap-2 rounded-2xl border border-line bg-surface p-2">
        <button
          type="button"
          onClick={() => onCreate("note", { text: "New note", color: "yellow" })}
          className="h-12 rounded-full border border-line px-4 text-fg hover:bg-ground"
        >
          + Note
        </button>
        <button
          type="button"
          onClick={() => onCreate("shape", { kind: "rect" })}
          className="h-12 rounded-full border border-line px-4 text-fg hover:bg-ground"
        >
          + Shape
        </button>
        <button
          type="button"
          onClick={() => onCreate("zone", { label: "Zone" })}
          className="h-12 rounded-full border border-line px-4 text-fg hover:bg-ground"
        >
          + Zone
        </button>
        <button
          type="button"
          onClick={() => setShowImagePrompt((v) => !v)}
          className="h-12 rounded-full border border-line px-4 text-fg hover:bg-ground"
        >
          + Image
        </button>
        {selected && (
          <button
            type="button"
            onClick={onDeleteSelected}
            disabled={!selected.isCreator}
            title={selected.isCreator ? "Delete selected object" : "Only the creator can delete this object"}
            className="h-12 rounded-full border border-danger px-4 text-danger hover:bg-ground disabled:cursor-not-allowed disabled:opacity-40"
          >
            Delete
          </button>
        )}
      </div>

      {showImagePrompt && (
        <div className="flex flex-wrap items-center justify-end gap-2 rounded-2xl border border-line bg-surface p-2">
          <input
            type="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://example.com/image.png"
            aria-label="Image address"
            className="h-12 w-56 max-w-full rounded-lg border border-line bg-ground px-3 text-base text-fg placeholder:text-fg-muted"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddImage();
            }}
          />
          <button type="button" onClick={handleAddImage} className="h-12 rounded-lg bg-accent px-4 text-base font-medium text-on-accent hover:bg-accent-hover">
            Add
          </button>
        </div>
      )}
    </div>
  );
}
