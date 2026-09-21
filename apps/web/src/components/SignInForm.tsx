"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
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
  variant = "page",
  secondaryAction,
}: {
  devAuth?: boolean;
  returnTo?: string;
  notice?: string;
  /** "hero": sits inside the landing page (no page title, inline field and button, and the
   *  page keeps its one main heading). "page": the standalone sign-in screen. */
  variant?: "page" | "hero";
  /** Beside the submit button in the hero (for example a "Request a Demo" link). */
  secondaryAction?: React.ReactNode;
}) {
  const hero = variant === "hero";
  const Title = hero ? "h2" : "h1";
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
      <div className={hero ? "mx-auto w-full max-w-md space-y-3 text-center" : "w-full max-w-sm space-y-3"}>
        <div aria-live="polite" className="space-y-3">
          <Title className="text-lg font-semibold">Check your email</Title>
          <p className="text-base text-fg">
            We sent a sign-in link to <span className="font-medium">{status.email}</span>. It works once and expires in
            15 minutes.
          </p>
        </div>
        <p className="text-base text-fg">Nothing yet? Check your spam folder, or send it again.</p>
        <button
          type="button"
          onClick={() => handleResend(status.email)}
          disabled={waiting || resending}
          className="min-h-12 w-full rounded bg-accent px-3 py-2 text-base font-medium text-on-accent disabled:opacity-50"
        >
          {resending ? "Sending…" : waiting ? `Send it again (${secondsLeft}s)` : "Send it again"}
        </button>
        {/* Said once when the wait starts and once when it ends, not every second. */}
        <p role="status" className="sr-only">
          {waiting ? `You can ask for another link in ${RESEND_WAIT_SECONDS} seconds.` : "You can send it again now."}
        </p>
        {resendError && (
          <p role="alert" className="text-base text-danger">
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
          className="text-base text-link hover:underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  const sending = status.kind === "sending";

  return (
    <div className={hero ? "mx-auto w-full max-w-3xl space-y-4" : "w-full max-w-sm space-y-6"}>
      {shownNotice && (
        <p role="alert" className="rounded border border-line bg-surface px-3 py-2 text-base text-fg">
          {shownNotice}
        </p>
      )}
      <form onSubmit={handleSubmit} className="space-y-3">
        {!hero && (
          <>
            <h1 className="text-lg font-semibold">Sign in</h1>
            <p className="text-base text-fg-muted">We&apos;ll email you a link. No password.</p>
          </>
        )}
        <label htmlFor="signin-email" className={hero ? "block text-base font-medium text-fg-muted" : "block text-base font-medium text-fg"}>
          {hero ? "Work email" : "Email"}
        </label>
        <div className={hero ? "flex flex-col gap-3 sm:flex-row sm:justify-center" : "space-y-3"}>
          <input
            id="signin-email"
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder={hero ? "you@company.com" : undefined}
            className="min-h-12 w-full rounded border border-line bg-surface px-3 py-2 text-base sm:max-w-md sm:flex-1"
          />
          <button
            type="submit"
            disabled={sending}
            className={`min-h-12 rounded bg-accent px-5 py-2 text-base font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-50 ${hero ? "w-full sm:w-auto" : "w-full"}`}
          >
            {sending ? "Sending…" : hero ? "Get started" : "Email me a link"}
          </button>
          {hero && secondaryAction}
        </div>
        {hero && (
          <p className="text-base text-fg-muted">
            By continuing you accept our{" "}
            <Link href="/terms" className="text-link underline underline-offset-4">
              Terms
            </Link>{" "}
            and{" "}
            <Link href="/privacy" className="text-link underline underline-offset-4">
              Privacy Policy
            </Link>
            .
          </p>
        )}
        {status.kind === "error" && (
          <p role="alert" className="text-base text-danger">
            {status.message}
          </p>
        )}
      </form>
      {devAuth && !hero && <DevSignInForm />}
    </div>
  );
}
