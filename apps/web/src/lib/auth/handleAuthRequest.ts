import type { SlidingWindowLimiter } from "./emailLimiter";

/** The part of a Better Auth instance this file needs. */
export interface AuthHandlerLike {
  handler(request: Request): Promise<Response>;
}

export interface HandleAuthOptions {
  /** Limits how many sign-in links one email address can ask for. */
  emailLimiter: SlidingWindowLimiter;
  /** This app's public address. Redirects are only accepted to this origin. */
  baseURL: string;
}

const REQUEST_LINK = "/sign-in/magic-link";
const VERIFY_LINK = "/magic-link/verify";
const REDIRECT_FIELDS = ["callbackURL", "newUserCallbackURL", "errorCallbackURL"] as const;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

/** True only for a path on this app, or an absolute address on this app's own
 *  origin. Resolving against the base URL makes `//host`, `/\host` and
 *  `javascript:` all come out as a different origin, so they are refused. */
function isOwnAddress(value: unknown, baseURL: string): boolean {
  if (typeof value !== "string") return false;
  try {
    const resolved = new URL(value, baseURL);
    return resolved.origin === new URL(baseURL).origin;
  } catch {
    return false;
  }
}

const invalidCallback = () =>
  json({ error: "invalid_callback", message: "That sign-in link asked to go to an address this app does not accept." }, 400);

/**
 * The one entry point for /api/auth/*. It adds the rules Better Auth does not
 * apply by default, then hands the request to Better Auth unchanged:
 *
 *   - redirect targets (callbackURL and friends) must be this app's own: without
 *     this, a sign-in link can send someone to another site, both after signing in
 *     and through the error redirect of a verify link
 *   - one email address can only ask for a few links in a short time (429)
 *   - if the email step fails, the person gets a clear 503, not an empty 500
 *
 * Every other path passes straight through, errors included.
 */
export async function handleAuthRequest(auth: AuthHandlerLike, request: Request, options: HandleAuthOptions): Promise<Response> {
  const { pathname, searchParams } = new URL(request.url);

  if (request.method === "GET" && pathname.endsWith(VERIFY_LINK)) {
    for (const field of REDIRECT_FIELDS) {
      const value = searchParams.get(field);
      if (value !== null && !isOwnAddress(value, options.baseURL)) return invalidCallback();
    }
    return auth.handler(request);
  }

  if (request.method === "POST" && pathname.endsWith(REQUEST_LINK)) {
    const body = await readJsonObject(request.clone());

    if (body) {
      for (const field of REDIRECT_FIELDS) {
        if (field in body && !isOwnAddress(body[field], options.baseURL)) return invalidCallback();
      }
      if (typeof body.email === "string" && body.email.trim() !== "") {
        const verdict = options.emailLimiter.attempt(body.email.trim().toLowerCase());
        if (!verdict.allowed) {
          return json(
            { error: "too_many_requests", message: "Too many sign-in requests for this address. Please try again in a few minutes." },
            429,
            { "retry-after": String(verdict.retryAfterSeconds) },
          );
        }
      }
    }

    const response = await auth.handler(request);
    if (response.status >= 500) {
      return json({ error: "send_failed", message: "We couldn't send the link. Please try again in a moment." }, 503);
    }
    return response;
  }

  return auth.handler(request);
}

async function readJsonObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed: unknown = JSON.parse(await request.text());
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
