import { redirect } from "next/navigation";
import { prisma, assertRoomMembership } from "@workspace-video/db";
import { spawnPositionForUser } from "@workspace-video/proximity";
import {
  resolveRoomLayout,
  zoneById,
  tileRectCenter,
  movementConfigForLayout,
  DEFAULT_MOVEMENT_CONFIG,
} from "@workspace-video/shared";
import { getSessionUser } from "@/lib/session";
import { RoomCanvas } from "@/components/RoomCanvas";
import { NoRoomAccess } from "@/components/NoRoomAccess";
import { returnPathForRoom, signInAddressFor } from "@/lib/returnPath";

/**
 * RSC guard: sign-in + workspace membership check before rendering the
 * canvas at all. Note this is NOT the security boundary for room access —
 * that's enforced independently by GET /api/rooms/[roomId]/endpoint (see
 * that route's docstring) precisely because a page-level guard like this
 * one can't stop someone from calling the API route directly. This guard
 * exists for UX (redirect to sign-in / a clear "not found" rather than a
 * broken canvas), not as the authorization mechanism.
 */
export default async function RoomPage({ params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;

  const session = await getSessionUser();
  if (!session) {
    // Sign in, then come back to this room (an invite link lands here).
    redirect(signInAddressFor(returnPathForRoom(roomId)));
  }

  try {
    await assertRoomMembership(session.userId, roomId);
  } catch {
    // Signed in, but not a member (or no such room: the person is not told which).
    return <NoRoomAccess email={session.email} />;
  }

  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });

  // Decided by the ONE function the realtime server also uses at join_room, so client and server
  // always agree on where the floor's bounds and spawn point are (see resolveRoomLayout in
  // @workspace-video/shared). A stored company map that fails its checks falls back, and the
  // reason is logged here as well as on the server.
  const { layout, problem } = resolveRoomLayout(room.config);
  if (problem) console.error(`Room ${roomId}: the stored map failed its checks, using the fallback layout. ${problem}`);
  const spawnZone = zoneById(layout, layout.spawnZoneId)!;
  const movementConfig = movementConfigForLayout(layout, DEFAULT_MOVEMENT_CONFIG);

  // Same deterministic ring-offset spawn the realtime server uses (see
  // apps/realtime/src/server.ts join_room handler) so the local avatar
  // doesn't visibly jump once the server's snapshot arrives.
  const initialLocalPosition = spawnPositionForUser(
    session.userId,
    tileRectCenter(spawnZone.rect),
    undefined,
    movementConfig,
  );

  return (
    <main className="h-screen w-screen overflow-hidden bg-ground">
      <div className="absolute left-1/2 top-3 z-10 hidden -translate-x-1/2 text-base text-fg-muted sm:block">
        {room.name}
      </div>
      <RoomCanvas
        roomId={roomId}
        localUserId={session.userId}
        initialLocalPosition={initialLocalPosition}
        layout={layout}
      />
    </main>
  );
}
