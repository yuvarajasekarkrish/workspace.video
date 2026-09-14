import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@cosmos/db";
import { env } from "@/lib/env";
import { signSessionToken, SESSION_COOKIE_NAME } from "@/lib/session";

/**
 * Dev-only "sign in as" flow: looks a seeded user up by email and issues a
 * session cookie, with no password. Hard-gated by env.devAuthEnabled (both
 * NODE_ENV !== "production" AND ENABLE_DEV_AUTH === "true") — in production,
 * or with the flag unset, this 404s rather than merely refusing, so it does
 * not even advertise its existence. Replaced by real Auth.js providers in
 * Phase 2; kept as the identity source behind the same session/token seam.
 */
export async function POST(req: NextRequest) {
  if (!env.devAuthEnabled) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const body = await req.json().catch(() => null);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : null;
  if (!email) {
    return NextResponse.json({ error: "email is required." }, { status: 400 });
  }

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    return NextResponse.json({ error: "No such seeded user." }, { status: 401 });
  }

  const token = signSessionToken({ userId: user.id, email: user.email });
  const response = NextResponse.json({
    ok: true,
    user: { id: user.id, email: user.email, name: user.name },
  });
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return response;
}
