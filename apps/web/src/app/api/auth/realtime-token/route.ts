import { NextResponse } from "next/server";
import { getSessionUser, signRealtimeToken } from "@/lib/session";

/**
 * Mints a short-lived token for the Socket.IO handshake. The socket client
 * needs this value in JS (unlike the httpOnly session cookie), so it is
 * returned in the response body — see lib/session.ts for why this is a
 * separate token from the session cookie, and lib/env.ts for the temporary
 * AUTH_SECRET-reuse note.
 */
export async function GET() {
  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  const token = signRealtimeToken(session);
  return NextResponse.json({ token });
}
