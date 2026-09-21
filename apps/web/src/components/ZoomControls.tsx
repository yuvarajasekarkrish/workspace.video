"use client";

import { Icon, type IconName } from "./icons";

export interface ZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Show the whole map again, centred. */
  onFit: () => void;
}

function ZoomButton({ label, icon, onClick }: { label: string; icon: IconName; onClick: () => void }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-12 w-12 items-center justify-center rounded-full text-fg transition-colors hover:bg-ground focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
    >
      <Icon name={icon} />
    </button>
  );
}

/** Zoom in, zoom out and "fit the whole map", stacked in the bottom-right corner. On a narrow screen the bar under the
 *  map spans the whole width, so the stack sits just above it instead of on top of its last button. */
export function ZoomControls({ onZoomIn, onZoomOut, onFit }: ZoomControlsProps) {
  return (
    <div
      role="group"
      aria-label="Zoom"
      className="absolute bottom-[92px] right-4 z-30 sm:bottom-4 flex flex-col items-center gap-0.5 rounded-full border border-line bg-surface p-1 shadow-lg"
    >
      <ZoomButton label="Zoom in" icon="plus" onClick={onZoomIn} />
      <ZoomButton label="Zoom out" icon="minus" onClick={onZoomOut} />
      <span aria-hidden="true" className="my-0.5 h-px w-5 bg-line" />
      <ZoomButton label="Fit whole map" icon="fit" onClick={onFit} />
    </div>
  );
}
