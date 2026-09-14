import "server-only";
import { AccessToken } from "livekit-server-sdk";
import { env } from "./env";

/**
 * Mints a LiveKit access token for one user joining one room.
 *
 * Identity is deliberately the application `userId`, never a display name or
 * a fresh random id: the client's SpatialAudioController maps
 * `proximity:update.peerId` (also the application userId) directly onto
 * `room.remoteParticipants.get(peerId)` with no translation table, so the two
 * MUST be the same value everywhere. `room` here is the application `roomId`,
 * matching how the realtime server's Socket.IO room is keyed.
 *
 * Grants intentionally omit video/screen-share and data publishing — audio
 * only for this phase (see the approved LiveKit plan's "out of scope"
 * section). `canPublishData: false` blocks LiveKit's data-channel messaging,
 * which this app has no use for and which would otherwise be a redundant,
 * unauthenticated-feeling side channel next to the already-validated
 * Socket.IO protocol.
 */
export async function signLiveKitToken(userId: string, displayName: string, roomId: string): Promise<string> {
  const token = new AccessToken(env.livekitApiKey, env.livekitApiSecret, {
    identity: userId,
    name: displayName,
    ttl: "1h",
  });
  token.addGrant({
    roomJoin: true,
    room: roomId,
    canPublish: true,
    canSubscribe: true,
    canPublishData: false,
  });
  return token.toJwt();
}
