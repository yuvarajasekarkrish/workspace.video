"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { PLAN_IDS, PLAN_LABELS, PLAN_PARTICIPANT_LIMITS, type PlanId } from "@cosmos/shared";

/**
 * Every plan renders the identical office floor (openOffice@1) — this form
 * only chooses Workspace.plan, which controls the concurrent-participant
 * limit (see @cosmos/shared's plans.ts), never the layout. No payment is
 * collected; any signed-in user may pick any plan until billing exists.
 */
export function CreateWorkspaceForm() {
  const [name, setName] = useState("");
  const [plan, setPlan] = useState<PlanId>("startup");
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
      body: JSON.stringify({ name, plan }),
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
        <p className="text-sm text-neutral-400">
          Every workspace gets the same office floor. Your plan sets how many people can be
          inside at the same time.
        </p>
      </div>

      <div className="space-y-1">
        <label htmlFor="workspace-name" className="block text-sm font-medium text-neutral-300">
          Workspace name
        </label>
        <input
          id="workspace-name"
          type="text"
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Northwind Studio"
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
      </div>

      <div className="space-y-2">
        <span className="block text-sm font-medium text-neutral-300">
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
                  ? "border-blue-500 bg-blue-950/40"
                  : "border-neutral-800 bg-neutral-900 hover:border-neutral-700"
              }`}
            >
              <div className="text-sm font-semibold text-neutral-100">{PLAN_LABELS[id]}</div>
              <div className="font-mono text-lg text-neutral-100">{PLAN_PARTICIPANT_LIMITS[id]}</div>
              <div className="text-xs text-neutral-400">people at once</div>
            </button>
          ))}
        </div>
      </div>

      <p className="text-xs text-neutral-500">No payment is taken.</p>

      <button
        type="submit"
        disabled={pending || !name.trim()}
        className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium disabled:opacity-50 sm:w-auto"
      >
        {pending ? "Creating…" : "Create workspace"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
