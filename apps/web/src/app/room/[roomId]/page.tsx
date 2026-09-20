import { redirect } from "next/navigation";
import { prisma, assertRoomMembership } from "@workspace-video/db";
import { spawnPositionForUser } from "@workspace-video/proximity";
import {
  parseRoomConfig,
  resolveLayout,
  DEFAULT_LAYOUT_ID,
  zoneById,
  tileRectCenter,
  movementConfigForLayout,
  DEFAULT_MOVEMENT_CONFIG,
} from "@workspace-video/shared";
import { getSessionUser } from "@/lib/session";
import { RoomCanvas } from "@/components/RoomCanvas";

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
    redirect("/");
  }

  try {
    await assertRoomMembership(session.userId, roomId);
  } catch {
    redirect("/");
  }

  const room = await prisma.room.findUniqueOrThrow({ where: { id: roomId } });

  // Resolved from Room.config, falling back to the default layout for a
  // missing/unknown id — the identical rule the realtime server applies at
  // join_room, so client and server always agree on where the floor's
  // bounds and spawn point are (see @workspace-video/shared's layouts module).
  const { layoutId } = parseRoomConfig(room.config);
  const layout = resolveLayout(layoutId) ?? resolveLayout(DEFAULT_LAYOUT_ID)!;
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
    <main className="h-screen w-screen overflow-hidden bg-[#0b0d12]">
      <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 text-sm text-neutral-400">
        {room.name}
      </div>
      <RoomCanvas
        roomId={roomId}
        localUserId={session.userId}
        initialLocalPosition={initialLocalPosition}
        layoutId={layout.id}
      />
    </main>
  );
}
