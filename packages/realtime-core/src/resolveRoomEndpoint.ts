import type { InstanceRegistry } from "./instanceRegistry";
import type { RoomLease } from "./roomLease";

export class NoLiveInstanceError extends Error {
  constructor() {
    super("No live realtime instance is registered to claim this room.");
    this.name = "NoLiveInstanceError";
  }
}

export class RoomOwnerResolutionError extends Error {
  constructor() {
    super("Failed to resolve a live owner for this room after repeated attempts.");
    this.name = "RoomOwnerResolutionError";
  }
}

/**
 * Called by the Next.js `GET /api/rooms/:id/endpoint` handler before a client
 * opens its socket. Combines the room lease with the instance registry so a
 * client is only ever handed the URL of an instance that is both the room's
 * current owner AND currently alive:
 *
 *   1. Claim-or-read the room lease using a freshly picked live instance as
 *      the candidate (claimOrRead is a no-op if someone already owns it).
 *   2. Look up that owner's instance record. If it's missing (heartbeat
 *      lapsed independently of the room lease TTL — e.g. the instance died
 *      right after claiming), treat the lease as stale, delete it, and retry
 *      with a fresh candidate rather than handing back a dead URL.
 *
 * Every concurrent caller doing this for the same unowned room converges on
 * the same instance, because step 1 is atomic (see RoomLease.claimOrRead).
 */
export async function resolveRoomEndpoint(
  roomId: string,
  lease: RoomLease,
  registry: InstanceRegistry,
  pickLiveInstanceId: () => Promise<string | null>,
  maxAttempts = 5,
): Promise<InstanceEndpoint> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const candidateId = await pickLiveInstanceId();
    if (!candidateId) throw new NoLiveInstanceError();

    const ownerId = await lease.claimOrRead(candidateId, roomId);
    const ownerRecord = await registry.get(ownerId);

    if (ownerRecord) {
      return { instanceId: ownerId, publicUrl: ownerRecord.publicUrl };
    }

    // Owner's heartbeat lapsed independently of the lease TTL (e.g. crashed
    // right after claiming, before the lease naturally expires). Clear the
    // stale claim so the next attempt's candidate can actually take it, and
    // try again rather than surfacing a URL nobody is listening on.
    await lease.release(ownerId, roomId);
  }

  throw new RoomOwnerResolutionError();
}

export interface InstanceEndpoint {
  instanceId: string;
  publicUrl: string;
}
