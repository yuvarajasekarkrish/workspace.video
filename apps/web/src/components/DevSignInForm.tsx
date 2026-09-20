"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Dev-only "sign in as" form — posts to /api/auth/dev-signin, which is itself
 * hard-gated (see lib/env.ts) and 404s outside development. Two browser profiles
 * signing in as different seeded emails is what the manual two-window check needs.
 */
export function DevSignInForm() {
  const [email, setEmail] = useState("test@example.com");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const router = useRouter();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/dev-signin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error ?? "Sign-in failed.");
        return;
      }
      router.push("/");
      router.refresh();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3 border-t border-neutral-800 pt-6">
      <h2 className="text-sm font-semibold text-neutral-300">Dev sign-in</h2>
      <p className="text-sm text-neutral-400">
        Enter a seeded user&apos;s email. Run <code>pnpm --filter @workspace-video/db run seed</code> first if you
        haven&apos;t.
      </p>
      <label htmlFor="dev-signin-email" className="block text-sm font-medium text-neutral-300">
        Seeded email
      </label>
      <input
        id="dev-signin-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
      />
      <button
        type="submit"
        disabled={pending}
        className="w-full rounded bg-neutral-700 px-3 py-2 text-sm font-medium disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in as"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-red-400">
          {error}
        </p>
      )}
    </form>
  );
}
