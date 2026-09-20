export interface LimiterOptions {
  /** Attempts allowed per key inside the window. */
  max: number;
  windowMs: number;
  /** Once more keys than this are held, keys with no attempt left in the window are dropped. */
  maxKeys?: number;
  now?: () => number;
}

export type LimiterResult = { allowed: true; retryAfterSeconds: 0 } | { allowed: false; retryAfterSeconds: number };

/**
 * Sliding-window limiter, held in this process's memory. Refused attempts are not
 * recorded, so a caller who keeps trying is let back in as soon as their oldest
 * attempt ages out. Memory is bounded by `maxKeys`.
 *
 * In-memory means one web process: the count resets on restart and is not shared
 * between instances. Fine for the first deploy; needs a shared store (Redis) before
 * the web app runs as more than one instance.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  private readonly maxKeys: number;

  constructor(private readonly options: LimiterOptions) {
    this.now = options.now ?? Date.now;
    this.maxKeys = options.maxKeys ?? 10_000;
  }

  attempt(key: string): LimiterResult {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.options.windowMs);

    if (recent.length >= this.options.max) {
      this.hits.set(key, recent);
      const retryAfterMs = this.options.windowMs - (now - recent[0]!);
      return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1000) };
    }

    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > this.maxKeys) this.sweep(now);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  size(): number {
    return this.hits.size;
  }

  private sweep(now: number): void {
    for (const [key, times] of this.hits) {
      if (times.every((t) => now - t >= this.options.windowMs)) this.hits.delete(key);
    }
  }
}
