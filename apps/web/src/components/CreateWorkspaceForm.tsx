"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  PLAN_IDS,
  PLAN_LABELS,
  PLAN_PARTICIPANT_LIMITS,
  DEFAULT_LAYOUT_ID,
  LAYOUT_LABELS,
  listLayoutIds,
  type PlanId,
} from "@workspace-video/shared";

/**
 * Chooses Workspace.plan, which controls the concurrent-participant limit (see
 * @workspace-video/shared's plans.ts), and the office template the first room
 * uses (any registered layout; office300@1 unless changed). The two are
 * independent. No payment is collected; any signed-in user may pick any plan
 * until billing exists.
 */
export function CreateWorkspaceForm() {
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<PlanId>("startup");
  const [layoutId, setLayoutId] = useState(DEFAULT_LAYOUT_ID);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const res = await fetch("/api/workspaces", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, plan, layoutId }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error ?? "Failed to create workspace.");
      setPending(false);
      return;
    }

    const body = await res.json();
    router.push(`/room/${body.roomId}`);
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-2xl space-y-6">
      <div>
        <h1 className="mb-1 text-lg font-semibold">Create a workspace</h1>
        <p className="text-base text-fg-muted">
          Pick an office floor. Your plan sets how many people can be inside at the same time.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="workspace-name" className="block text-base font-medium text-fg">
          Workspace name
        </label>
        <input
          id="workspace-name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Northwind Studio"
          className="min-h-12 w-full rounded border border-line bg-surface px-3 py-2 text-base"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="workspace-template" className="block text-base font-medium text-fg">
          Office template
        </label>
        <select
          id="workspace-template"
          value={layoutId}
          onChange={(e) => setLayoutId(e.target.value)}
          className="min-h-12 w-full rounded border border-line bg-surface px-3 py-2 text-base"
        >
          {listLayoutIds().map((id) => (
            <option key={id} value={id}>
              {LAYOUT_LABELS[id] ?? id}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <span className="block text-base font-medium text-fg">
          How many people will be in the office at once?
        </span>
        <div role="radiogroup" className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {PLAN_IDS.map((id) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={plan === id}
              onClick={() => setPlan(id)}
              className={`rounded-lg border p-3 text-left transition-colors ${
                plan === id
                  ? "border-accent bg-accent/15"
                  : "border-line bg-surface hover:border-fg-muted"
              }`}
            >
              <div className="text-base font-semibold text-fg">{PLAN_LABELS[id]}</div>
              <div className="font-mono text-lg text-fg">{PLAN_PARTICIPANT_LIMITS[id]}</div>
              <div className="text-base text-fg-muted">people at once</div>
            </button>
          ))}
        </div>
      </div>

      <p className="text-base text-fg-muted">No payment is taken.</p>

      <button
        type="submit"
        disabled={pending || !name.trim()}
        className="min-h-12 w-full rounded bg-accent px-3 py-2 text-base font-medium text-on-accent disabled:opacity-50 sm:w-auto"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
      {error && <p className="text-base text-danger">{error}</p>}
    </form>
  );
}
