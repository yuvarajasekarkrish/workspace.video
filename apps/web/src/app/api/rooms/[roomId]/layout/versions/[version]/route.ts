import { NextRequest } from "next/server";
import { getLayoutVersion } from "@workspace-video/db";
import { getSessionUser } from "@/lib/session";
import { answer, badRequest, notSignedIn, versionFromAddress } from "@/lib/layoutApi";

/** One saved version with its map, for opening it in the builder. Owner, admin or designer only. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ roomId: string; version: string }> }) {
  const { roomId, version: versionText } = await params;
  const session = await getSessionUser();
  if (!session) return notSignedIn();
  const version = versionFromAddress(versionText);
  if (version === null) return badRequest("The version must be a whole number, 1 or more.");
  return answer(await getLayoutVersion({ roomId, actorUserId: session.userId, version }));
}
