/**
 * What to tell someone who lands on the sign-in page with `?error=...` after
 * opening a sign-in link that did not work. Better Auth reports a link that was
 * already used, or has expired, with these codes; anything else gets a plain
 * message. The code itself is never shown.
 */
const USED_OR_EXPIRED = "That link has expired or was already used. Enter your email to get a new one.";
const OTHER = "That sign-in link didn't work. Enter your email to get a new one.";

export function describeLinkError(code: unknown): string | undefined {
  if (typeof code !== "string" || code === "") return undefined;
  if (code === "INVALID_TOKEN" || code === "EXPIRED_TOKEN") return USED_OR_EXPIRED;
  return OTHER;
}
