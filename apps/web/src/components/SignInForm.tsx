"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Dev-only "sign in as" form — posts to /api/auth/dev-signin, which is
 * itself hard-gated (see lib/env.ts) and 404s outside development. Two
 * browser profiles signing in as different seeded emails is exactly the
 * setup Milestone 1's manual verification needs.
 */
export function SignInForm() {
  const [email, setEmail] = useState("test@example.com");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setError(null);

    const res = await fetch("/api/auth/dev-signin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });

    setPending(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      setError(body?.error ?? "Sign-in failed.");
      return;
    }
    router.push("/");
    router.refresh();
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3">
      <h1 className="text-lg font-semibold">Sign in (dev)</h1>
      <p className="text-sm text-neutral-400">
        Enter a seeded user&apos;s email. Run <code>pnpm --filter @workspace-video/db run seed</code> first
        if you haven&apos;t.
      </p>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="test@example.com"
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
    </form>
  );
}
