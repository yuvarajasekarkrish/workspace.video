import { NextRequest } from "next/server";
import { listLayoutVersions, saveLayoutVersion } from "@workspace-video/db";
import { getSessionUser } from "@/lib/session";
import { answer, badRequest, notSignedIn, readJsonObject, wholeNumber } from "@/lib/layoutApi";

/** The history of a room's map, newest first, and which version is live. Owner, admin or designer only. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const session = await getSessionUser();
  if (!session) return notSignedIn();
  return answer(await listLayoutVersions({ roomId, actorUserId: session.userId }));
}

/**
 * Saves a map as a new version. Body: { map, baseVersion, note? }, where baseVersion is the newest version the
 * editor started from (0 when there is none). Owner, admin or designer only; a save from an old version is
 * refused with 409 and the newest version number.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const session = await getSessionUser();
  if (!session) return notSignedIn();

  const body = await readJsonObject(req);
  if (!body) return badRequest("The request must be a JSON object.");
  const baseVersion = wholeNumber(body.baseVersion, 0);
  if (baseVersion === null) return badRequest("baseVersion must be a whole number, 0 or more.");
  if (!("map" in body)) return badRequest("map is required.");
  const note = typeof body.note === "string" ? body.note.slice(0, 200) : undefined;

  return answer(await saveLayoutVersion({ roomId, actorUserId: session.userId, map: body.map, baseVersion, note }));
}
