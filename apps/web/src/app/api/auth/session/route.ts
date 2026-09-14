import { NextResponse } from "next/server";
import { prisma } from "@cosmos/db";
import { getSessionUser } from "@/lib/session";

/** Returns the current user from the session cookie, or 401. Used by the
 *  client to know who's signed in without exposing the token itself. */
export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, name: true },
  });
  if (!user) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  return NextResponse.json({ user });
}
