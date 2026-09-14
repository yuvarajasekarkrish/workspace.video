import { redirect } from "next/navigation";
import { prisma, assertRoomMembership } from "@cosmos/db";
import { spawnPositionForUser } from "@cosmos/proximity";
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

  // Same deterministic ring-offset spawn the realtime server uses (see
  // apps/realtime/src/server.ts join_room handler) so the local avatar
  // doesn't visibly jump once the server's snapshot arrives.
  const initialLocalPosition = spawnPositionForUser(session.userId, { x: 100, y: 100 });

  return (
    <main className="h-screen w-screen overflow-hidden bg-[#0b0d12]">
      <div className="absolute left-1/2 top-3 z-10 -translate-x-1/2 text-sm text-neutral-400">
        {room.name}
      </div>
      <RoomCanvas roomId={roomId} localUserId={session.userId} initialLocalPosition={initialLocalPosition} />
    </main>
  );
}
