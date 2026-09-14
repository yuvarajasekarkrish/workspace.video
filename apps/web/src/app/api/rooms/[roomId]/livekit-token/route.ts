import { NextRequest, NextResponse } from "next/server";
import { assertRoomMembership } from "@cosmos/db";
import { getSessionUser } from "@/lib/session";
import { signLiveKitToken } from "@/lib/livekit";
import { env } from "@/lib/env";

/**
 * Mints a LiveKit access token for the caller to join this room's spatial
 * audio. Mirrors rooms/[roomId]/endpoint/route.ts exactly, and for the same
 * reason: a route handler is reachable directly with an arbitrary roomId, so
 * it must authorize itself rather than rely on the page-level RSC guard.
 * Reuses the same `assertRoomMembership` check the socket path and the
 * endpoint route already enforce — not a second, divergent copy of it — and
 * returns the identical 404 for "room doesn't exist" and "not a member" so
 * this is not a room-id oracle either.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;

  const session = await getSessionUser();
  if (!session) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }

  try {
    await assertRoomMembership(session.userId, roomId);
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const token = await signLiveKitToken(session.userId, session.email, roomId);
  return NextResponse.json({ token, url: env.livekitUrl });
}
