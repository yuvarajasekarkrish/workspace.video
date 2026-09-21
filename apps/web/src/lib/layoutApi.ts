import { NextResponse } from "next/server";

/**
 * Small helpers shared by the layout and role routes, so each route stays a few lines: it finds out who is
 * signed in, reads and checks the request, and hands over to the database functions, which apply the
 * who-may-do-what rules (packages/db/src/roomLayouts.ts). The actor is ALWAYS the signed-in person; nothing in
 * a request body can name someone else.
 */

const STATUS_FOR_REASON = { forbidden: 403, not_found: 404, invalid: 400, conflict: 409, last_owner: 409 } as const;

type Failure = { ok: false; reason: keyof typeof STATUS_FOR_REASON; message: string };

/** Turns a database answer into a response: success passes through; a refusal becomes its status, with
 *  the plain message as `error` and any details (the reasons a map was refused, the newest version). */
export function answer(result: { ok: true } | Failure): NextResponse {
  if (result.ok) return NextResponse.json(result);
  const { ok: _ok, message, ...details } = result;
  return NextResponse.json({ error: message, ...details }, { status: STATUS_FOR_REASON[result.reason] });
}

export const notSignedIn = () => NextResponse.json({ error: "Not signed in." }, { status: 401 });

export const badRequest = (message: string) => NextResponse.json({ error: message, reason: "invalid" }, { status: 400 });

/** The request body as a plain object, or null when it is not JSON or not an object. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await req.json().catch(() => null);
  return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
}

/** A whole number at or above `min`, or null. */
export function wholeNumber(value: unknown, min: number): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= min ? value : null;
}

/** A version number from an address: digits only, 1 or more, no sign, no decimals. */
export function versionFromAddress(value: string): number | null {
  return /^[1-9]\d{0,8}$/.test(value) ? Number(value) : null;
}
