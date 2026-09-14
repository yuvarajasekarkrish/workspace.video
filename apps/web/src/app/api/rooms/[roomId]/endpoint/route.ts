import { NextRequest, NextResponse } from "next/server";
import { assertRoomMembership } from "@cosmos/db";
import { resolveRoomEndpoint, NoLiveInstanceError, RoomOwnerResolutionError } from "@cosmos/realtime-core";
import { getSessionUser } from "@/lib/session";
import { roomLease, instanceRegistry } from "@/lib/realtimeInfra";

/**
 * Resolves which realtime instance a client should connect to for a room.
 *
 * This route MUST authorize independently of any page/RSC guard: it is a
 * plain route handler reachable directly with an arbitrary `roomId`, and
 * unlike a read-only lookup, resolveRoomEndpoint can *claim* the room's
 * ownership lease (see packages/realtime-core/src/roomLease.ts). Skipping
 * the check here would let any authenticated caller claim ownership of, and
 * probe the existence of, rooms they have no access to. So: authenticate
 * from the session cookie, confirm workspace membership for this exact
 * room (the same rule apps/realtime enforces on `join_room`, not a
 * second/divergent copy of it), and only then touch the lease. An
 * unauthorized or nonexistent room both come back as 404, so this endpoint
 * is not a room-id oracle either.
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
    // Same response whether the room doesn't exist or the caller isn't a
    // member of its workspace — don't leak which one it was.
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    const endpoint = await resolveRoomEndpoint(
      roomId,
      roomLease,
      instanceRegistry,
      async () => {
        const ids = await instanceRegistry.listActiveIds();
        if (ids.length === 0) return null;
        return ids[Math.floor(Math.random() * ids.length)]!;
      },
    );
    return NextResponse.json(endpoint);
  } catch (err) {
    if (err instanceof NoLiveInstanceError || err instanceof RoomOwnerResolutionError) {
      return NextResponse.json({ error: err.message }, { status: 503 });
    }
    throw err;
  }
}
