import type { Redis } from "ioredis";

/**
 * Every realtime process registers itself here with a heartbeat-refreshed TTL.
 * A record's mere presence (the Redis key hasn't expired) is what "alive" means —
 * we don't separately compare timestamps, since Redis expiry is already the
 * authoritative liveness signal and avoids clock-skew bugs across instances.
 */
export interface InstanceRecord {
  instanceId: string;
  publicUrl: string;
}

function instanceKey(instanceId: string): string {
  return `instance:${instanceId}`;
}

// A Redis Set for enumeration (`SMEMBERS`) alongside the per-instance TTL
// keys, which stay the actual source of truth for liveness. The set can
// accumulate ids whose individual key has since expired (SADD has no TTL),
// so `listActiveIds` treats a missing individual key as "prune from the set"
// rather than trusting set membership on its own.
const ACTIVE_SET_KEY = "instances:active";

export interface InstanceRegistryOptions {
  /** How long a registration is valid without a heartbeat refresh. */
  ttlSeconds: number;
}

export class InstanceRegistry {
  constructor(
    private readonly redis: Redis,
    private readonly options: InstanceRegistryOptions,
  ) {}

  /** Registers or refreshes this instance's presence. Call on startup and on
   *  a heartbeat interval well under `ttlSeconds` (e.g. ttl/3). */
  async heartbeat(record: InstanceRecord): Promise<void> {
    await Promise.all([
      this.redis.set(
        instanceKey(record.instanceId),
        JSON.stringify(record),
        "EX",
        this.options.ttlSeconds,
      ),
      this.redis.sadd(ACTIVE_SET_KEY, record.instanceId),
    ]);
  }

  /** Returns the live record for an instance, or null if it never registered
   *  or its heartbeat has lapsed (key expired). */
  async get(instanceId: string): Promise<InstanceRecord | null> {
    const raw = await this.redis.get(instanceKey(instanceId));
    if (!raw) return null;
    return JSON.parse(raw) as InstanceRecord;
  }

  async deregister(instanceId: string): Promise<void> {
    await Promise.all([
      this.redis.del(instanceKey(instanceId)),
      this.redis.srem(ACTIVE_SET_KEY, instanceId),
    ]);
  }

  /** Ids of instances that are actually live right now — verified against
   *  each candidate's real TTL key, not just set membership, and lazily
   *  pruning any id whose key has since expired without a clean deregister. */
  async listActiveIds(): Promise<string[]> {
    const candidates = await this.redis.smembers(ACTIVE_SET_KEY);
    if (candidates.length === 0) return [];

    const checks = await Promise.all(
      candidates.map(async (id) => ({ id, alive: (await this.redis.exists(instanceKey(id))) === 1 })),
    );

    const stale = checks.filter((c) => !c.alive).map((c) => c.id);
    if (stale.length > 0) {
      await this.redis.srem(ACTIVE_SET_KEY, ...stale);
    }

    return checks.filter((c) => c.alive).map((c) => c.id);
  }
}
