/**
 * Where to send someone once they have signed in, remembered in the address as
 * `/?next=/room/abc`. The value comes from the address bar, so it is untrusted:
 * only a page on this site is accepted, never another site, and never the API.
 */
const MAX_LENGTH = 512;

export function safeReturnPath(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_LENGTH) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if (value.includes("\\")) return null;
  // Control characters (a line break here could split a header).
  if (/[\u0000-\u001f\u007f]/.test(value)) return null;
  if (value === "/api" || value.startsWith("/api/")) return null;
  return value;
}

export function returnPathForRoom(roomId: string): string {
  return `/room/${encodeURIComponent(roomId)}`;
}

/** The sign-in (home) address that remembers where the person was going. */
export function signInAddressFor(returnPath: string): string {
  return `/?next=${encodeURIComponent(returnPath)}`;
}
