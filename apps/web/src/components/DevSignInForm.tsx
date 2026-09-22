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
      // A convenience for the one seeded email every local dev session uses (packages/db/prisma/
      // seed.ts always gives test@example.com the room "seed-room-1"): skip the landing page and
      // land straight in that room. Any other email still goes to "/", since only this one email's
      // room id is known ahead of time.
      router.push(email.trim().toLowerCase() === "test@example.com" ? "/room/seed-room-1" : "/");
      router.refresh();
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="w-full max-w-sm space-y-3 border-t border-line pt-6">
      <h2 className="text-base font-semibold text-fg">Dev sign-in</h2>
      <p className="text-base text-fg-muted">
        Enter a seeded user&apos;s email. Run <code>pnpm --filter @workspace-video/db run seed</code> first if you
        haven&apos;t.
      </p>
      <label htmlFor="dev-signin-email" className="block text-base font-medium text-fg">
        Seeded email
      </label>
      <input
        id="dev-signin-email"
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="min-h-12 w-full rounded border border-line bg-surface px-3 py-2 text-base"
      />
      <button
        type="submit"
        disabled={pending}
        className="min-h-12 w-full rounded border border-line bg-surface px-3 py-2 text-base font-medium text-fg disabled:opacity-50"
      >
        {pending ? "Signing in…" : "Sign in as"}
      </button>
      {error && (
        <p role="alert" className="text-base text-danger">
          {error}
        </p>
      )}
    </form>
  );
}
