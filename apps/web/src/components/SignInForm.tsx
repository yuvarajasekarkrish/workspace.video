"use client";

import { useState } from "react";
import { DevSignInForm } from "./DevSignInForm";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; email: string } | { kind: "error"; message: string };

/** What the person is told for each way the request can fail. The server's own
 *  message is used when it sent one, because it already says what to do. */
async function describeFailure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (res.status === 400 && body?.code === "VALIDATION_ERROR") return "Enter a valid email address.";
  if ((res.status === 429 || res.status === 503) && typeof body?.message === "string") return body.message;
  return "Something went wrong. Please try again.";
}

/**
 * Sign in with an emailed one-time link: enter an address, get a link, open it.
 * No password. `devAuth` (set by the page from env.devAuthEnabled) adds the
 * development "sign in as a seeded user" form underneath.
 */
export function SignInForm({ devAuth = false }: { devAuth?: boolean }) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status.kind === "sending") return;
    setStatus({ kind: "sending" });

    try {
      const res = await fetch("/api/auth/sign-in/magic-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, callbackURL: "/" }),
      });
      if (!res.ok) {
        setStatus({ kind: "error", message: await describeFailure(res) });
        return;
      }
      setStatus({ kind: "sent", email });
    } catch {
      setStatus({ kind: "error", message: "Couldn't reach the server. Check your connection and try again." });
    }
  }

  if (status.kind === "sent") {
    return (
      <div className="w-full max-w-sm space-y-3" aria-live="polite">
        <h1 className="text-lg font-semibold">Check your email</h1>
        <p className="text-sm text-neutral-300">
          We sent a sign-in link to <span className="font-medium">{status.email}</span>. It works once and expires in 15
          minutes.
        </p>
        <button
          type="button"
          onClick={() => {
            setEmail("");
            setStatus({ kind: "idle" });
          }}
          className="text-sm text-blue-400 hover:underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  const sending = status.kind === "sending";

  return (
    <div className="w-full max-w-sm space-y-6">
      <form onSubmit={handleSubmit} className="space-y-3">
        <h1 className="text-lg font-semibold">Sign in</h1>
        <p className="text-sm text-neutral-400">We&apos;ll email you a link. No password.</p>
        <label htmlFor="signin-email" className="block text-sm font-medium text-neutral-300">
          Email
        </label>
        <input
          id="signin-email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={sending}
          className="w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium disabled:opacity-50"
        >
          {sending ? "Sending…" : "Email me a link"}
        </button>
        {status.kind === "error" && (
          <p role="alert" className="text-sm text-red-400">
            {status.message}
          </p>
        )}
      </form>
      {devAuth && <DevSignInForm />}
    </div>
  );
}
