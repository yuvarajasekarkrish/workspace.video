"use client";

import { useConnectionStore } from "@/store/connectionStore";

export interface CapacityScreenProps {
  onRetry: () => void;
}

/**
 * Full-screen state shown when join_room is rejected with workspace_full.
 * Rendered as a sibling overlay on top of the (unmounted) canvas rather than
 * inside it — there is nothing to show behind it, since the join never
 * succeeded and PixiStage was never told to enter the room.
 */
export function CapacityScreen({ onRetry }: CapacityScreenProps) {
  const status = useConnectionStore((s) => s.status);
  const capacity = useConnectionStore((s) => s.capacity);

  if (status !== "workspace_full") return null;

  const { active = 0, limit = 0 } = capacity ?? {};

  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="mx-4 max-w-sm rounded-lg bg-neutral-900 p-6 text-center shadow-xl">
        <h2 className="mb-2 text-lg font-semibold text-neutral-100">This workspace is full</h2>
        <p className="mb-4 text-sm text-neutral-400">
          <span className="font-mono text-neutral-200">
            {active} / {limit}
          </span>{" "}
          people online. A spot will open up when someone leaves.
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:bg-accent-hover"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
