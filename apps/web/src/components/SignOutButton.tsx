"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/** Ends the current session on the server (the session row is deleted, so the
 *  cookie stops working everywhere) and reloads to show the signed-out page. */
export function SignOutButton() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  async function handleClick() {
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const res = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (!res.ok) {
        setError("Couldn't sign out. Try again.");
        setPending(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Couldn't sign out. Try again.");
      setPending(false);
    }
  }

  return (
    <div className="text-right">
      <button
        type="button"
        onClick={handleClick}
        disabled={pending}
        className="rounded border border-neutral-700 px-3 py-1.5 text-sm text-neutral-300 hover:bg-neutral-800 disabled:opacity-50"
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
      {error && (
        <p role="alert" className="mt-1 text-xs text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}
