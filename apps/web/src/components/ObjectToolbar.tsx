"use client";

import { useState } from "react";
import type { CanvasObjectType } from "@cosmos/shared";
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
 * imperative work, matching AudioControls' relationship to
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
    <div className="absolute right-3 top-3 flex flex-col items-end gap-2 text-xs">
      <div className="flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 backdrop-blur">
        <button
          type="button"
          onClick={() => onCreate("note", { text: "New note", color: "yellow" })}
          className="rounded-full bg-neutral-700 px-3 py-1 text-white hover:bg-neutral-600"
        >
          + Note
        </button>
        <button
          type="button"
          onClick={() => onCreate("shape", { kind: "rect" })}
          className="rounded-full bg-neutral-700 px-3 py-1 text-white hover:bg-neutral-600"
        >
          + Shape
        </button>
        <button
          type="button"
          onClick={() => onCreate("zone", { label: "Zone" })}
          className="rounded-full bg-neutral-700 px-3 py-1 text-white hover:bg-neutral-600"
        >
          + Zone
        </button>
        <button
          type="button"
          onClick={() => setShowImagePrompt((v) => !v)}
          className="rounded-full bg-neutral-700 px-3 py-1 text-white hover:bg-neutral-600"
        >
          + Image
        </button>
        {selected && (
          <button
            type="button"
            onClick={onDeleteSelected}
            disabled={!selected.isCreator}
            title={selected.isCreator ? "Delete selected object" : "Only the creator can delete this object"}
            className="rounded-full bg-red-700 px-3 py-1 text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Delete
          </button>
        )}
      </div>

      {showImagePrompt && (
        <div className="flex items-center gap-2 rounded-full bg-black/50 px-3 py-1.5 backdrop-blur">
          <input
            type="url"
            value={imageUrl}
            onChange={(e) => setImageUrl(e.target.value)}
            placeholder="https://example.com/image.png"
            className="w-56 rounded border border-neutral-600 bg-neutral-900 px-2 py-1 text-white"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddImage();
            }}
          />
          <button type="button" onClick={handleAddImage} className="rounded bg-emerald-600 px-2 py-1 text-white">
            Add
          </button>
        </div>
      )}
    </div>
  );
}
