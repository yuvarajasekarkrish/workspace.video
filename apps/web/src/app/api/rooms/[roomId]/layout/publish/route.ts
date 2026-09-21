import { NextRequest } from "next/server";
import { publishLayoutVersion } from "@workspace-video/db";
import { getSessionUser } from "@/lib/session";
import { answer, badRequest, notSignedIn, readJsonObject, wholeNumber } from "@/lib/layoutApi";

/**
 * Makes a saved version the room's live map. Body: { version, expectedLiveVersion }, where expectedLiveVersion is
 * the live version the editor saw (null when none). Owner, admin or designer only. If someone published in the
 * meantime the answer is 409 with the live version. The new map is used the next time the room is empty.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ roomId: string }> }) {
  const { roomId } = await params;
  const session = await getSessionUser();
  if (!session) return notSignedIn();

  const body = await readJsonObject(req);
  if (!body) return badRequest("The request must be a JSON object.");
  const version = wholeNumber(body.version, 1);
  if (version === null) return badRequest("version must be a whole number, 1 or more.");
  const expectedLiveVersion = body.expectedLiveVersion === null ? null : wholeNumber(body.expectedLiveVersion, 1);
  if (body.expectedLiveVersion === undefined || (body.expectedLiveVersion !== null && expectedLiveVersion === null)) {
    return badRequest("expectedLiveVersion must be the live version you saw, or null when none is live.");
  }

  return answer(await publishLayoutVersion({ roomId, actorUserId: session.userId, version, expectedLiveVersion }));
}
