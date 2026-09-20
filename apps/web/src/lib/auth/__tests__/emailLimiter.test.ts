import { describe, it, expect } from "vitest";
import { SlidingWindowLimiter } from "../emailLimiter";

function limiter(max: number, windowMs: number, maxKeys?: number) {
  let now = 1_000_000;
  const l = new SlidingWindowLimiter({ max, windowMs, maxKeys, now: () => now });
  return { l, advance: (ms: number) => (now += ms) };
}

describe("SlidingWindowLimiter", () => {
  it("allows up to max attempts in the window, then refuses", () => {
    const { l } = limiter(3, 60_000);
    expect([1, 2, 3].map(() => l.attempt("a").allowed)).toEqual([true, true, true]);
    expect(l.attempt("a").allowed).toBe(false);
  });

  it("tells a refused caller how many whole seconds until the oldest attempt expires", () => {
    const { l, advance } = limiter(2, 60_000);
    l.attempt("a");
    advance(10_000);
    l.attempt("a");
    advance(5_000);
    const refused = l.attempt("a");
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 45 });
  });

  it("does not count refused attempts against the caller", () => {
    const { l, advance } = limiter(1, 60_000);
    l.attempt("a");
    for (let i = 0; i < 20; i++) l.attempt("a");
    advance(60_001);
    expect(l.attempt("a").allowed).toBe(true);
  });

  it("slides: attempts age out one at a time", () => {
    const { l, advance } = limiter(2, 60_000);
    l.attempt("a");
    advance(30_000);
    l.attempt("a");
    expect(l.attempt("a").allowed).toBe(false);
    advance(30_001); // the first attempt is now 60,001 ms old
    expect(l.attempt("a").allowed).toBe(true);
    expect(l.attempt("a").allowed).toBe(false);
  });

  it("keeps keys independent", () => {
    const { l } = limiter(1, 60_000);
    expect(l.attempt("a").allowed).toBe(true);
    expect(l.attempt("b").allowed).toBe(true);
    expect(l.attempt("a").allowed).toBe(false);
  });

  it("stays bounded: once past maxKeys, keys whose attempts have all expired are dropped", () => {
    const { l, advance } = limiter(5, 1_000, 3);
    for (const k of ["a", "b", "c"]) l.attempt(k);
    expect(l.size()).toBe(3);
    advance(2_000);
    l.attempt("d"); // over the cap: sweeps the three expired keys
    expect(l.size()).toBe(1);
  });
});
