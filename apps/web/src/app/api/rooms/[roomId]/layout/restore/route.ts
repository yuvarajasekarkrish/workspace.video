import { NextRequest } from "next/server";
import { restoreLayoutVersion } from "@workspace-video/db";
import { getSessionUser } from "@/lib/session";
import { answer, badRequest, notSignedIn, readJsonObject, wholeNumber } from "@/lib/layoutApi";

/** Saves an earlier version's map again as the newest version. Body: { version }. Owner, admin or designer only.
 *  Nothing already saved is changed. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const session = await getSessionUser();
  if (!session) return notSignedIn();

  const body = await readJsonObject(req);
  if (!body) return badRequest("The request must be a JSON object.");
  const version = wholeNumber(body.version, 1);
  if (version === null) return badRequest("version must be a whole number, 1 or more.");

  return answer(await restoreLayoutVersion({ roomId, actorUserId: session.userId, version }));
}
