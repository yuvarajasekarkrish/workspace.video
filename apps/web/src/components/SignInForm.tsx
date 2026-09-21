"use client";

import { useEffect, useState } from "react";
import { DevSignInForm } from "./DevSignInForm";
import { signInAddressFor } from "@/lib/returnPath";

type Status = { kind: "idle" } | { kind: "sending" } | { kind: "sent"; email: string } | { kind: "error"; message: string };

/** How long before "Send it again" works: long enough that a slow email is not
 *  answered by a second one, short enough not to feel stuck. */
const RESEND_WAIT_SECONDS = 30;

/** What the person is told for each way the request can fail. The server's own
 *  message is used when it sent one, because it already says what to do. */
async function describeFailure(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { code?: string; message?: string } | null;
  if (res.status === 400 && body?.code === "VALIDATION_ERROR") return "Enter a valid email address.";
  if ((res.status === 429 || res.status === 503) && typeof body?.message === "string") return body.message;
  return "Something went wrong. Please try again.";
}

/** Asks the server to email a sign-in link. Resolves to an error message, or null on success. */
async function requestLink(email: string, returnTo: string | undefined): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/sign-in/magic-link", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        returnTo
          ? // Come back to this page after the link is opened; if the link has been used or has
            // expired, return to sign-in with the page remembered, so a new link leads there too.
            { email, callbackURL: returnTo, errorCallbackURL: signInAddressFor(returnTo) }
          : { email, callbackURL: "/" },
      ),
    });
    if (!res.ok) return await describeFailure(res);
    return null;
  } catch {
    return "Couldn't reach the server. Check your connection and try again.";
  }
}

/**
 * Sign in with an emailed one-time link: enter an address, get a link, open it.
 * No password.
 *  - `returnTo`: the page the person was going to (an invite to a room); they land
 *    there after the link is opened.
 *  - `notice`: shown above the form, for example when the link they opened has
 *    expired or was already used.
 *  - `devAuth` (set by the page from env.devAuthEnabled) adds the development
 *    "sign in as a seeded user" form underneath.
 */
export function SignInForm({
  devAuth = false,
  returnTo,
  notice,
}: {
  devAuth?: boolean;
  returnTo?: string;
  notice?: string;
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [shownNotice, setShownNotice] = useState<string | undefined>(notice);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendError, setResendError] = useState<string | null>(null);

  // One timer at a time, and none once the wait is over or the screen goes away.
  useEffect(() => {
    if (secondsLeft <= 0) return;
    const timer = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(timer);
  }, [secondsLeft]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (status.kind === "sending") return;
    setShownNotice(undefined);
    setStatus({ kind: "sending" });

    const failure = await requestLink(email, returnTo);
    if (failure) {
      setStatus({ kind: "error", message: failure });
      return;
    }
    setResendError(null);
    setSecondsLeft(RESEND_WAIT_SECONDS);
    setStatus({ kind: "sent", email });
  }

  async function handleResend(sentTo: string) {
    if (resending || secondsLeft > 0) return;
    setResending(true);
    setResendError(null);
    const failure = await requestLink(sentTo, returnTo);
    setResending(false);
    if (failure) {
      setResendError(failure);
      return;
    }
    setSecondsLeft(RESEND_WAIT_SECONDS);
  }

  if (status.kind === "sent") {
    const waiting = secondsLeft > 0;
    return (
      <div className="w-full max-w-sm space-y-3">
        <div aria-live="polite" className="space-y-3">
          <h1 className="text-lg font-semibold">Check your email</h1>
          <p className="text-sm text-neutral-300">
            We sent a sign-in link to <span className="font-medium">{status.email}</span>. It works once and expires in
            15 minutes.
          </p>
        </div>
        <p className="text-sm text-neutral-300">Nothing yet? Check your spam folder, or send it again.</p>
        <button
          type="button"
          onClick={() => handleResend(status.email)}
          disabled={waiting || resending}
          className="min-h-12 w-full rounded bg-blue-600 px-3 py-2 text-base font-medium disabled:opacity-50"
        >
          {resending ? "Sending…" : waiting ? `Send it again (${secondsLeft}s)` : "Send it again"}
        </button>
        {/* Said once when the wait starts and once when it ends, not every second. */}
        <p role="status" className="sr-only">
          {waiting ? `You can ask for another link in ${RESEND_WAIT_SECONDS} seconds.` : "You can send it again now."}
        </p>
        {resendError && (
          <p role="alert" className="text-sm text-red-400">
            {resendError}
          </p>
        )}
        <button
          type="button"
          onClick={() => {
            setEmail("");
            setResendError(null);
            setSecondsLeft(0);
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
      {shownNotice && (
        <p role="alert" className="rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-200">
          {shownNotice}
        </p>
      )}
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
