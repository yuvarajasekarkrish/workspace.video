import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@workspace-video/db";
import { env } from "@/lib/env";
import { devSignInCookies } from "@/lib/auth/devSignIn";

/**
 * Dev-only "sign in as" flow: looks a seeded user up by email and signs them in
 * with a real Better Auth session, with no email and no password. Hard-gated by
 * env.devAuthEnabled (both NODE_ENV !== "production" AND ENABLE_DEV_AUTH ===
 * "true") — in production, or with the flag unset, this 404s rather than merely
 * refusing, so it does not even advertise its existence. It never creates an
 * account: an email that is not already seeded gets 401.
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

  const response = NextResponse.json({
    ok: true,
    user: { id: user.id, email: user.email, name: user.name },
  });
  for (const cookie of await devSignInCookies(email)) {
    response.headers.append("set-cookie", cookie);
  }
  return response;
}
