"use client";

import { useConnectionStore } from "@/store/connectionStore";

const LABEL: Record<string, string> = {
  idle: "Idle",
  "resolving-endpoint": "Resolving…",
  connecting: "Connecting…",
  joining: "Joining…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
  workspace_full: "Workspace full",
  error: "Error",
};

const DOT_COLOR: Record<string, string> = {
  idle: "bg-fg-muted",
  "resolving-endpoint": "bg-amber-400",
  connecting: "bg-amber-400",
  joining: "bg-amber-400",
  connected: "bg-emerald-400",
  reconnecting: "bg-amber-400",
  workspace_full: "bg-red-500",
  error: "bg-red-500",
};

/** Subscribes to connectionStore, the one store React is allowed to
 *  subscribe to directly — it changes on connect/disconnect/error only,
 *  never on movement (see store/connectionStore.ts). */
export function ConnectionBadge() {
  const status = useConnectionStore((s) => s.status);
  const error = useConnectionStore((s) => s.error);

  return (
    <div className="flex items-center gap-2 rounded-full border border-line bg-surface px-4 py-2 text-base text-fg">
      <span className={`h-3 w-3 rounded-full ${DOT_COLOR[status] ?? "bg-fg-muted"}`} />
      <span>{LABEL[status] ?? status}</span>
      {error && status === "error" && <span className="text-danger">— {error}</span>}
    </div>
  );
}
