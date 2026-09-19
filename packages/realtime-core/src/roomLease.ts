import type { Redis } from "ioredis";

/**
 * Sticky room-to-instance ownership. In-memory position state and the 100ms
 * proximity tick are only correct if every peer in a room is handled by the
 * same realtime instance, so exactly one instance holds the "lease" for a
 * room at a time. This is a lease, not a lock: it expires on its own if the
 * owner dies, and only the current owner is ever allowed to renew or release it.
 *
 * Every mutating operation here is a single atomic Redis command (SET NX EX,
 * or a Lua script for compare-and-mutate) so concurrent callers racing to
 * claim, refresh, or release the same room can never both believe they won.
 */

function ownerKey(roomId: string): string {
  return `room:${roomId}:owner`;
}

// Compare-and-refresh, with a third outcome for a lease that expired with no
// competing claimant. A bare EXPIRE would let an instance that already lost
// ownership resurrect a lease it no longer holds; a bare "not equal -> lost"
// would treat "the key is simply gone" the same as "someone else now owns
// it" — but those call for very different responses (see refresh()'s doc).
const REFRESH_SCRIPT = `
local current = redis.call("GET", KEYS[1])
if current == ARGV[1] then
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  return "renewed"
elseif current == false then
  redis.call("SET", KEYS[1], ARGV[1], "EX", ARGV[2])
  return "reclaimed"
else
  return "lost"
end
`;

// Compare-and-delete: only release if the caller is still the recorded owner.
const RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
else
  return 0
end
`;

export class RoomLease {
  constructor(
    private readonly redis: Redis,
    private readonly leaseTtlSeconds: number,
  ) {}

  /**
   * Atomically claims the room for `candidateInstanceId` if unowned, or reads
   * back the current owner if someone else already holds it. Callers racing
   * this for the same room all converge on whichever one Redis let win the
   * SET NX — this method is claim-or-read, never claim-then-read, so there is
   * no window where two callers could both believe they succeeded.
   */
  async claimOrRead(candidateInstanceId: string, roomId: string): Promise<string> {
    const claimed = await this.redis.set(
      ownerKey(roomId),
      candidateInstanceId,
      "EX",
      this.leaseTtlSeconds,
      "NX",
    );
    if (claimed === "OK") return candidateInstanceId;

    const current = await this.redis.get(ownerKey(roomId));
    // Vanishingly unlikely (lease expired between the failed NX and this GET)
    // but handled: fall back to trying to claim it ourselves.
    if (!current) return this.claimOrRead(candidateInstanceId, roomId);
    return current;
  }

  /**
   * Three-way outcome, because "the key isn't ours" has two very different
   * causes that callers must not treat the same way:
   *  - "renewed": we were still the recorded owner; TTL extended.
   *  - "reclaimed": the key had expired (no GET match, but also no other
   *    owner) — nobody raced us for it, so re-claiming it is the correct,
   *    safe outcome. Colloquially: we own every peer/socket/tick for this
   *    room regardless of what Redis briefly forgot, so this is a self-heal,
   *    not an incident that should evict anyone.
   *  - "lost": a *different* instance now holds the key. This is the only
   *    outcome that means we are no longer authoritative and must evict.
   * All three are decided and applied inside one atomic script, so a
   * "reclaimed" here can never race another instance's own claim.
   */
  async refresh(instanceId: string, roomId: string): Promise<"renewed" | "reclaimed" | "lost"> {
    const result = await this.redis.eval(
      REFRESH_SCRIPT,
      1,
      ownerKey(roomId),
      instanceId,
      this.leaseTtlSeconds,
    );
    return result as "renewed" | "reclaimed" | "lost";
  }

  /** Releases the lease, but only if `instanceId` is still the recorded
   *  owner — never blind-deletes, so a stale/late release can't clobber a
   *  lease some other instance has since legitimately claimed. */
  async release(instanceId: string, roomId: string): Promise<boolean> {
    const result = await this.redis.eval(RELEASE_SCRIPT, 1, ownerKey(roomId), instanceId);
    return result === 1;
  }

  /** Read-only check of current ownership, used by the Socket.IO server to
   *  refuse a `join` if it is not (or is no longer) the authoritative owner. */
  async currentOwner(roomId: string): Promise<string | null> {
    return this.redis.get(ownerKey(roomId));
  }
}
