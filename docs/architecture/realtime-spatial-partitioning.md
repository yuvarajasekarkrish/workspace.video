# Realtime spatial partitioning (Phase 9)

## Problem

Phase 8's load harness showed the proximity tick averaging 151ms with a 7.3s worst case at 200
concurrent users, against a 100ms tick interval. The cause was `tickProximity`
(`packages/proximity/src/proximity.ts`), which checked every pair of peers every tick — O(n²),
~19,900 pair checks at n=200 — and `RoomManager`'s two companion maps (`proximityStates`,
`lastEmittedAudio`), which stored an entry for every pair ever seen, including permanently
far-apart ones, and were pruned on disconnect by scanning every key with `startsWith`/`endsWith`.

## Structure

Two new primitives in `packages/proximity/src/spatial-index.ts` and `proximity.ts` replace the
full-pair scan; `tickProximity` itself is untouched and still backs its own tests and the
naive-equivalence oracle.

### `UniformGridIndex` — the spatial hash

A uniform grid over the room's floor. Cell keys are small integers (`cellKey = cy * cols + cx`,
`cols` derived from an explicit world width), never strings — this avoids the two failure modes a
naive `"${x},${y}"` string key would have: allocation cost per lookup, and no worked-out collision
story. Positions outside `[0, width] x [0, height]` are clamped into the edge cell rather than
producing a negative or wrapping key.

**Cell size = `audioRadiusPx + hysteresisPx` = 525px.** This is the largest distance at which
`computeProximityState` can return anything other than NOT_NEARBY — a pair already subscribed
stays subscribed until they cross `audioRadiusPx + hysteresisPx`. Sizing the cell to exactly that
distance is what makes the neighbour search exhaustive with only the four half-neighbours below,
not the full 3x3.

**Boundary correctness.** If two points are within `cellSize` px of each other, their cell
coordinates differ by at most 1 on each axis (a cell spans exactly `cellSize` px on a side) — so
every pair that could possibly be non-NOT_NEARBY is either in the same cell or one of the 8
neighbouring cells.

**No duplicate pairs, no dedupe set.** `forEachCandidatePair` visits same-cell pairs with `i < j`,
then only the East/South-East/South/South-West half-neighbourhood. Every unordered pair spanning
two adjacent cells is reachable from exactly one side of that half (the pair across a cell and its
West neighbour is caught when iterating the West cell's East neighbour), so each pair is visited
once, with no need to track what's already been seen.

**Lockstep bookkeeping.** `RoomManager` calls `index.insert`/`index.move`/`index.remove` at every
position write (`admitAndAddPeer`, `applyMove`, `claimSeat`'s teleport, `removePeer`) — the index
is never rebuilt from scratch, and a same-cell move is a no-op besides updating the stored point.

### `SparseProximityTracker` — the engine

Storage is `Map<userId, Map<userId, ProximityState>>`, holding **only** non-NOT_NEARBY pairs,
indexed from both sides. `tick(index, config, onChange)`:

1. Walks `index.forEachCandidatePair`, rejecting on squared distance before the `sqrt`, and only
   calls the unchanged `computeProximityState` for pairs within the cell radius.
2. A pair that was stored last tick but wasn't visited this tick has moved far enough apart that
   the grid no longer even considers it a candidate — which only happens once `d > cellSize`,
   itself `>= audioRadiusPx + hysteresisPx` — so the true state is unambiguously NOT_NEARBY. A
   per-tick epoch counter (not a Set) marks what was visited, so this costs one integer comparison
   per stored pair, not an allocation.

`removeUser(id)` and `neighborsOf(id)` are both O(degree) — the number of peers this user is
currently near — never O(n) or O(all pairs ever seen in the room's lifetime).

### Zone-audio candidates: the part that isn't just distance

`effectiveAudio` (`packages/proximity/src/zoneAudio.ts`, unchanged) can grant full-gain audio
between two people who are **physically far apart** — an audience always hears its stage, and
everyone in one meeting room hears each other, regardless of in-room distance. Those pairs would
never appear as grid neighbours, so `RoomManager.tickBody` builds its directed-recheck candidate
set as:

```
raw distance changes
∪ (for every user whose zone just changed) their grid neighbours
∪ (for every user whose zone just changed) their OLD and NEW zone's counterpart members
∪ (for every user whose zone just changed) every pair they already have a lastEmittedAudio entry for
```

"Counterpart members" (`RoomManager.zoneRecheckCounterparts`) is zone-kind-specific: a stage
zone's counterpart is every member of its linked audience zone(s); an audience zone's counterpart
is its linked stage's members; a meeting/cabin/open/focus zone's counterpart is its own other
members. This is what lets a stage speaker and an audience member 700px apart still re-check audio
the instant either one crosses into their zone, without scanning every peer in the room.

`lastEmittedAudio` is nested `listener -> speaker -> state`, with a reverse index (`audienceOf:
speaker -> Set<listener>`) purely so `removePeer` can prune "this departing user as someone else's
speaker" in O(degree) instead of scanning every listener's map.

### Emit volume: the other half

Audio gain is a continuous function of distance, so it changes on nearly every accepted move for
every in-range pair — Phase 8 sent all of those. `maybeEmitDirectedAudio` now suppresses a
pure-gain change smaller than 0.02 (subscribe/unsubscribe edges and gain hitting exactly 0 or 1
still always send), comparing against the **last actually-sent** value so small steps accumulate
rather than being silently dropped one comparison at a time. The client already smooths gain
locally, so a step this small was already inaudible.

## Complexity

| | Phase 8 | Phase 9 |
|---|---|---|
| Pair checks/tick | O(n²) — every pair, every tick | O(candidate pairs) — grid neighbours only |
| Storage | every pair ever seen (raw + directed audio) | only currently-nearby pairs |
| Disconnect cleanup | O(all keys ever stored), string `startsWith`/`endsWith` scan | O(degree) |
| Per-tick allocation | fresh Maps/Sets/arrays every tick | reused scratch, integer keys, no string pair-keys in the hot path |

## Measured performance

### Isolated tick cost (no network/socket I/O — `RoomManager.runTickForTest` against a no-op
broadcaster, random-walk peers on the real 1760x1760 `openOffice@1` floor, half seated)

| N | avg | p50 | p95 | max |
|---|---|---|---|---|
| 50 | 1.0ms | 0.5ms | 2.8ms | 39.9ms |
| 100 | 2.0ms | 1.7ms | 3.4ms | 17.7ms |
| 200 | 19.2ms | 15.8ms | 41.9ms | 155.1ms |
| 500 | 157.9ms | 150.8ms | 297.7ms | 438.2ms |

This isolates the algorithmic change: **200 concurrent went from Phase 8's 151ms avg / 7.3s max to
19.2ms avg / 155ms max** — roughly an 8x average-case improvement and a ~47x improvement in the
worst observed tick, with the proximity computation itself no longer the dominant cost at 200.
At 500, the pure computation already exceeds the 100ms tick budget on this floor — this is the
plan's pre-flagged A8 risk (the real `openOffice@1` floor is 1760x1760px, not 8000x8000px, so at
enough density a genuinely large fraction of pairs are physically in range regardless of indexing)
rather than a pair-checking inefficiency; spatial partitioning has done its job by n=500, the
remaining cost is real audio-candidate density.

### Live harness (`apps/realtime/src/scripts/loadHarness.ts`, real Socket.IO clients + server on
one dev machine)

| N | Scenario | Tick avg/p50/p95/p99/max | Pair checks/tick | Emits/tick | Join p95 |
|---|---|---|---|---|---|
| 50 | spread | 107/78/350/380/380ms | 204 | 206 | 539ms |
| 100 | spread | 123/78/364/622/2314ms | 304 | 303 | 826ms |
| 200 | spread | 229/48/1015/1470/3834ms | 316 | 386 | 2794ms |
| 200 | cluster | 374/84/1431/4278/7117ms | 433 | 541 | 2597ms |

**This did not cleanly hit the acceptance targets, and the isolated benchmark above shows why:**
pair checks/tick dropped from ~19,900 (Phase 8, n=200) to 316–540 (Phase 9) — the O(n²) fix
worked — but the live tick duration is dominated by something else. The harness also logged
5,000–10,000 `move:correction` (`max_speed_exceeded`) events at N≥100: when the server's own tick
briefly blocks the single-threaded event loop, queued `move` messages for the same peer are
processed back to back once it unblocks, and the server's elapsed-time check (correctly, from its
own clock) sees too little real time between them for the implied distance.

> **Correction (Phase 10):** this doc originally attributed the gap to "the server and harness
> sharing CPU in one process." That was imprecise — they are always separate OS processes (the
> harness spawns real `socket.io-client` sockets; it doesn't run inside the server). What they
> share is the **machine's CPU**, and more importantly, Phase 9 never actually measured emit cost,
> Redis publish volume, or event-loop delay — it inferred them from `avgEmits`/tick alone. Phase 10
> (below) measured all three directly and found a specific, fixable cause.

## Correctness

- `spatial-index.test.ts` (10 tests): insertion/removal, same-cell vs cross-cell moves, exact
  boundary distances, diagonal-neighbour pairs, far pairs excluded, fuzz equivalence against
  `NaiveSpatialIndex`.
- `sparseProximity.test.ts` (8 tests): nearby detection, AOI entry/exit, hysteresis across a cell
  boundary, O(degree) `removeUser`, rejoin re-emit, and a random-walk equivalence property test
  against `tickProximity` (excluding the documented Phase 8 "always reports on first sight, even
  NOT_NEARBY" divergence, which no client-side consumer observes).
- `roomManager.test.ts` (+13 tests): disconnect prunes the index/tracker/zone maps without
  touching unrelated peers; a same-userId reconnect still re-emits; far-apart stage↔audience and
  same-meeting-room audio; a scripted zone-transition oracle checking RoomManager's emitted audio
  against `effectiveAudio`'s ground truth across raw-nearby ↔ raw-far ↔ same-meeting-room ↔
  stage/audience ↔ different-private-zone transitions.
- All 358 Phase 1–8 tests pass unmodified except two assertions in the "zone override never
  corrupts the raw cache" test, updated to read `undefined` as NOT_NEARBY — the sparse tracker's
  documented divergence from Phase 8's full-pair Map (a never-nearby pair is simply never stored,
  rather than stored as an explicit false entry).

## Remaining bottleneck (superseded by Phase 10 — see below)

Phase 9 suspected Socket.IO emit volume/serialization cost. Phase 10 measured it directly,
confirmed a specific cause (Redis-adapter publish overhead on every tick emit, not raw
serialization cost), fixed it, and re-measured — see "Phase 10: emit cost validation" below for
the actual finding and its result.

## Is 200 production-ready? Is 500 viable?

Answered in "Phase 10: emit cost validation" below with corrected numbers — Phase 9's tick/join
figures on this page are superseded, not just contextualized.

## Recommended next phase

See "Phase 10: emit cost validation"'s own recommended next phase at the end of this document.

---

# Phase 10: emit cost validation

## Problem

Phase 9 ended without measuring what it suspected: Socket.IO emit volume, Redis publish rate,
event-loop delay, and server CPU were never actually read, only inferred from `avgEmits`/tick.
Phase 10 measures all four, finds the real cause, fixes it, and reports the corrected numbers.

## What was actually measured (new in `/internal/metrics`)

- **Per-phase tick breakdown** — `RoomManager.tickBody` now marks four boundaries
  (`positionsMs`, `proximityMs`, `zoneMs`, `audioEmitMs`), each with its own rolling p50/p95/p99
  (`RoomManager.getTickStats().phases`). This is what let "emission is dominant" become a
  measured claim instead of a guess.
- **`CountingBroadcaster`** (`apps/realtime/src/countingBroadcaster.ts`) wraps the room
  broadcaster, counting emits per event name and sampling payload size 1-in-20 (JSON-stringifying
  every payload would itself have added cost to the exact path being measured).
- **Redis publish counter** (`apps/realtime/src/instance.ts`) — `redisPub.publish` is
  monkey-patched to increment a counter, so every PUBLISH the `@socket.io/redis-adapter` issues
  on `redisPub`'s connection is counted, not assumed.
- **Event-loop delay** — `perf_hooks.monitorEventLoopDelay()`, reset on every `/internal/metrics`
  read, so p50/p99/max describe the window since the last read.
- **Server CPU%** — `process.cpuUsage()` deltas since the last read, as % of one core.
- All of the above are "since the last read" deltas (the same contract `process.cpuUsage()`
  already uses), computed in `server.ts`'s `/internal/metrics` handler. The load harness reads
  metrics once right before the measurement window starts (resetting these deltas cleanly) and
  once after, so the reported numbers describe only the steady-state walking window, not the
  join/seat setup before it.

## What was found

At real N=200 (`same-machine` label, built server via `tsx dist/server.js`, no CPU pinning,
LiveKit stopped since realtime doesn't use it):

| Phase | avg (spread) | avg (cluster) | share of tick |
|---|---|---|---|
| positions | 7.0ms | 8.0ms | ~3% |
| proximity | 12.8ms | 16.2ms | ~6% |
| zone | 3.4ms | 4.1ms | ~1.5% |
| **audioEmit** | **203.0ms** | **244.9ms** | **~90%** |
| **tick total** | **224.8ms** | **274.5ms** | |

`audioEmit` — the directed-audio loop and its `proximity:update` emits — was ~90% of the tick.
**Redis publishes/sec: ~999**, essentially one PUBLISH per emit. The cause: `broadcasterFromSocketServer`
called plain `io.to(...).emit(...)` for every tick-path event, and `@socket.io/redis-adapter`'s
`broadcast()` msgpack-encodes and PUBLISHes every such call in addition to local delivery — real
work, on the synchronous tick path, for cross-instance fan-out that **does nothing useful**: every
socket in a room is on the lease-owning instance by construction (`join_room` in `server.ts`
refuses to admit a socket into a room this instance doesn't own), so no other instance is ever
listening for these events on this room. Event-loop delay p99 was 3.2–3.3 **seconds** at N=200,
consistent with hundreds of synchronous Redis-adapter encode+publish calls per tick.

## The fix

`broadcasterFromSocketServer` (`apps/realtime/src/roomManager.ts`) now routes exactly three
tick-path event names — `peers:delta`, `proximity:update`, `zone:changed` — through
`io.local.to(...)` instead of `io.to(...)`, skipping the redis-adapter's cross-instance fan-out for
those events only. Every other emit (object sync, seats, occupancy, `owner:changed` — none of them
on the 100ms tick loop) is untouched and still cross-instance-capable, in case that ever matters
for a future multi-instance feature on those paths. Tests:
`broadcasterFromSocketServer.test.ts` — tick-path events assert `io.local.to` is called and
`io.to` is not; every other tested event asserts the reverse.

## Result (same server build, same machine, before vs after)

| Metric | Before (same-machine) | After (after-local-emit) | Change |
|---|---|---|---|
| Redis publishes/sec | ~994 | **0.0** | eliminated |
| audioEmit phase avg | 203–245ms | 25–30ms | ~8x faster |
| audioEmit share of tick | ~90% | 25–39% | no longer dominant |
| tick avg | 225–274ms | 78–101ms | ~2.5–3x faster |
| tick p50 | 27ms | 24–49ms | roughly flat |
| tick p95 | 951–1383ms | 255–349ms | ~3–4x better, still above the 25ms target |
| tick p99 | 2027–3942ms | 1114ms (both) | better, still above the 50ms target |
| event-loop delay p99 | 3.2–3.3s | 1.8–3.8s | still spiky |
| join p95 | 2.9–3.1s | 1.6–6.9s (spread/cluster) | inconsistent, not clearly improved |
| `move:correction` count | ~10,000 | 5,804–12,483 | not clearly improved |

Full JSON for both runs: `apps/realtime/load-results/same-machine-200-{spread,cluster}.json` and
`after-local-emit-200-{spread,cluster}.json` (gitignored; regenerate with
`LOAD_HARNESS_LABEL=<label> LOAD_HARNESS_ONLY_N=200 pnpm --filter @cosmos/realtime run load-harness`).

**Per the plan's own decision gate** ("if it fails for another reason [than an emit phase over
half the tick], stop and report the numbers — no further optimization without evidence"): with
`audioEmit` now at 25–39% of the tick, no single phase is the dominant cost anymore, so Step 4.2
(batching `proximity:update` into one payload per listener) was **not** attempted — the evidence
that would justify it is no longer there. The remaining p95/p99 spikes and event-loop delay are
now spread roughly proportionally across all four phases (matching each phase's own p95 versus its
avg), which points to something shared across the whole tick — real Socket.IO delivery to ~200
real local sockets, GC pauses, or the load harness's own ~200 `socket.io-client` connections and
~100 `setInterval` timers competing for the same machine's CPU — rather than one fixable line of
code in `RoomManager`.

## Isolation attempt (same-machine CPU pinning) — inconclusive, reported honestly

The approved plan called for measuring with the server and load-generating harness on separate
CPU budgets. This machine is a 4-thread AMD Ryzen 3 3200U laptop also running Postgres, Redis, and
(normally) LiveKit in Docker — there is no spare machine or cloud VM available, so the approved
fallback was same-machine CPU pinning: server on logical CPUs 0–1 (`ProcessorAffinity = 3`),
harness on CPUs 2–3 (`ProcessorAffinity = 12`), LiveKit stopped for the duration.

One clean data point was obtained (`isolated-200-spread.json`, **before** the local-emit fix):
tick avg 528ms, `audioEmit` avg 489ms (92.6% of tick), Redis publishes/sec 369 — the same
dominant-audioEmit/Redis-publish signature as the unpinned run, at a worse absolute number because
halving the server's available CPU cost more than the harness's own reduced CPU stole back. This
is corroborating evidence, not new evidence, and the intended comparison (isolated *before* vs
*after* the fix) could not be completed:

Running the `cluster` scenario under the same pinning caused the harness's own `socket.io-client`
connections to time out, and the server process itself became unresponsive and had to be
restarted — **2 logical CPUs cannot reliably sustain 200 real Socket.IO connections on this
hardware**, a genuine finding about the isolation method itself, not about the server code being
validated. Continued attempts to force a clean isolated before/after pair on this laptop would
have spent more time thrashing the method than the method could ever return in confidence — the
same-machine before/after comparison above already isolates the ONE thing that changed (the code),
which is the more decisive comparison for attributing the fix's effect either way.

## Is 200 production-ready? Is 500 viable?

**200 concurrent:** The specific, measured cause of Phase 9's unexplained gap — unnecessary Redis
PUBLISHes on every tick emit — is fixed, with a clearly attributable ~2.5–3x tick-time improvement
and the emit phase no longer dominant. **200 is still not validated as comfortably
production-ready**: p95/p99 tick time, event-loop delay, and `move:correction` counts remain above
target on this hardware, and — per the decision gate above — there is no longer a single
attributable cause to fix next; the next real signal has to come from a genuinely separate-machine
measurement (see below), not more same-machine guessing.

**500 concurrent:** not attempted. The plan gates 500-user work on 200 validating first; it did
not. Phase 9's isolated-computation finding (≈158ms avg at n=500, real floor density, not
pair-checking) still stands independently of this phase's emit work.

## Recommended next phase

1. **Get an actual second machine or cloud VM** for the harness (or the server) — same-machine
   CPU pinning on a 4-thread laptop demonstrably cannot sustain 200 real connections without
   becoming the confound itself (see "Isolation attempt" above). This is the one change most
   likely to turn an inconclusive number into a decisive one.
2. With genuine isolation, re-run the same-machine-vs-isolated comparison this phase intended,
   using the per-phase/CPU/event-loop instrumentation already built (nothing new to instrument).
3. Only if a phase is then clearly >50% of tick again, apply the matching Step 4 optimization
   (batching `proximity:update`, or a leaner wire format) — don't batch pre-emptively.
4. 500-user work stays gated behind 200 validating, per the approved plan.

---

# Phases 11-17: concurrent real users, and where the event-loop tail comes from

Phases 9-10 were about tick cost. These phases were about what happens with real concurrent
sockets: joins, disconnects, rubber-banding, and a failing event-loop p99 gate at N=100.

## Phases 11-14 (pointers only)

Detail lives in the commits; this document does not restate findings it has not re-verified.

| Phase | Commit | Subject |
|---|---|---|
| 11 | `715ed3c` | fix lease-eviction bug, cut `join_room` latency |
| 12 | `2a6f21b` | diagnose the mass-disconnect independent of Phase 11's fix |
| 13 | `d88ee01` | guard against a stale forward, measure the harness's own event loop |
| 14 | `df6b8c1` | instrument the Engine.IO heartbeat path itself |

## Phase 15: join fast-path bug, move-validation instrumentation

- Fixed the join fast path reading `participantLimit` as 0 (`ebc6a95`).
- Read-only instrumentation for rejected moves: emit-vs-arrival gaps, cross-user clustering in the
  same 10ms, and a per-tick window of event-loop utilization, cpu/wall ratio and tick time.
- Result: at N=30 there were 0 corrections. At N=100 all 100 sockets survived but 1.85% of moves
  were corrected and the server event-loop p99 was ~64ms. Rejections did not cluster across users
  (0 of the observed rejected moves shared a 10ms instant with another user beyond chance).

## Phase 16: concurrency defects and rubber-banding

Test-first for each; structural extraction (`registerSocketHandlers`) landed as its own commit.

| Defect | Fix |
|---|---|
| A stale socket's disconnect removed the peer that had already reconnected under the same userId | `removePeer` takes the disconnecting socket id and ignores a stale one (`staleDisconnectsIgnored` counter) |
| A join racing a room eviction created a fresh room record while the old one was still flushing | join awaits the in-flight eviction before `ensureRoom` (record stays in `rooms` during flush) |
| Server stalls were charged to users as speed violations | `validateMove` banks unspent allowance up to `maxBurstMs` (default 200ms); credit resets on seat teleport |

Known residual (not fixed): a small admit-during-eviction window, and a first-move snap-back after
some reconnects (~10%, inferred, not measured).

Result (N=100, 60s, 20 reconnects, co-located): corrections 0.004-0.007% (was 1.85%), occupancy
100 after 20 reconnects, stale disconnects ignored = 20 per 20 churns.

## Phase 17: where the ~60-70ms event-loop p99 comes from

The remaining failing gate at N=100 was event-loop p99 (59-72ms against a 50ms limit) while tick
p95 was 22-25ms. Everything below is N=100, 60s, spread, 20 reconnects, server and harness on one
Codespace, no tunnel. Numbers only; the reading follows.

### Ruled out (measured)

| Candidate | Measurement |
|---|---|
| A slow emit | every emit timed: max 4.1-7.4ms over ~1.25-1.4M emits; none at 10ms or more |
| Garbage collection | max pause 5.7-7.5ms (~180-230 pauses); no long window overlaps a 20ms pause |
| Inbound move handling | in the CPU profile, `tryParse` 48ms and app code 53ms of 17.5s post-tick busy time |
| The tick alone | tick p50 ~15-17ms, max ~28-35ms |

### What the pattern is

A probe measures, after each tick, how long the loop takes to reach its check phase (`postTickMs`).
The tick plus this burst is the loop's away-time around one tick.

| Run | post-tick burst p50 / p90 / p99 | windows with tick+burst >= 50ms | event-loop p99 |
|---|---|---|---|
| A | 23.2 / 31.6 / 42.0 ms | 56/400 | 62.21ms |
| B (replicate) | 22.8 / 31.5 / 41.9 ms | 49/400 | 59.13ms |

So the p99 is a recurring structural pattern (about one long iteration in seven or eight), not rare stalls.

### What the burst consists of

- `node --cpu-prof`, 670 ticks: post-tick busy time is 79% one native function, `writev` (13.8s of
  17.5s). 99.8% of it has one call chain: Engine.IO `flush` -> WebSocket `sendFrame` -> stream
  `uncork` -> `clearBuffer` -> `writev`. Median busy run after a tick: 27.3ms (harness burst p50
  23.2ms; the two agree loosely, profiler overhead and different run boundaries).
- `strace -c` (server and children traced): **663,783 `writev` calls, 12.29s, ~18µs per call**;
  `write` 2,068; `sendto` 367. The two methods agree on the `writev` time within ~11%.
- The same strace run: 609,800 emit calls, 304 measured ticks (the ring was not full, so this is the
  run's tick count). That is **1.09 `writev` per emit call, ~2,180 per tick, ~22 per socket per
  tick**. The server was slowed by tracing (304 ticks in a ~60s window instead of ~600, median tick
  23.4ms instead of ~15.5ms, emits about half of untraced runs), so the ratios describe the
  traced run; the untraced per-call cost is implied to be lower (~10µs: 13.8s of profiled
  `writev` over roughly the untraced emit count), an inference, not a measurement.
- Library source (ws 8.21.3, engine.io 6.6.10): `Sender.sendFrame` corks, writes header and
  payload, uncorks (one `writev` per WebSocket frame); the Engine.IO WebSocket transport sends
  each packet as its own frame. So `writev` count tracks packets delivered, one per packet.
  A room broadcast is encoded once but still costs one `writev` per recipient socket.

### Cork and batched experiment (`src/scripts/experiments/corkBench.ts`, Codespace, N=100 x 22 updates per 100ms round)

Real Socket.IO server and clients on loopback, clients in a child process; three modes rotated across
5 blocks of 60 rounds. Every frame delivered in every mode, 0 out of order.

| per round | plain (22 frames/socket) | corked (22 frames/socket) | batched (1 frame/socket) |
|---|---|---|---|
| frames sent (300 rounds) | 704,000 | 704,000 | 32,000 |
| JSON bytes per socket per round | ~2,904 | ~2,926 | ~2,122 |
| send start -> check phase p50 / p90 / p99 | 24.05 / 36.75 / 47.42 ms | 23.68 / 35.88 / 45.03 ms | 2.85 / 5.11 / 7.92 ms |
| system CPU p50 | 15.93 ms | 15.33 ms | 1.03 ms |
| user+system CPU p50 | 24.31 ms | 23.80 ms | 2.99 ms |

- The plain run reproduces the burst (p50 24ms) with no application logic at all.
- **Batched cuts the burst ~8x and system CPU ~15x** while sending ~27% fewer bytes (the plain frames repeat two small fields; that byte difference cannot explain a 15x drop). So the cost scales with frames, not bytes.
- **The cork result is not evidence about the syscall count.** Engine.IO sends a socket's first packet immediately and holds the rest in `writeBuffer` until the transport is writable again; each is then sent as its own frame with its own cork/uncork (`socket.js flush()`, `websocket.js send`). An outside cork therefore covered only the first packet. An earlier reading here, "cost dominated by per-byte loopback work, so batching would not help", was wrong and is superseded.
- Limits: synthetic load (identical updates, loopback, one run, no client-side parse cost measured), not the real tick.

### Reading

The burst is one `writev` syscall per delivered packet (per WebSocket frame), flushed after each
tick (~2,100-2,200 packets per tick at N=100). The batched experiment above shows the cost scales with
the number of frames, not with bytes.

Not established:
- whether this holds for the untraced run at the same per-frame ratio (only the traced run has a
  syscall count);
- whether loopback co-location inflates the per-call cost (a receiver's network processing can run
  inside the sender's syscall). No run with clients on another machine exists;
- whether this reproduces for real remote clients.

### Records of what was wrong along the way

- A per-tick reset of a private loop-delay histogram was blind to the tick's own blocking, so its
  "no stalled windows" result was void; it was removed (`90d1924`).
- Early guesses that the burst was inbound move handling, and that it was ~100 calls of ~0.2ms
  each, were both wrong and are superseded by the numbers above.
- The tick-window ring was returned rotated after wrapping and had no timestamp; fixed at the
  producer (`atMs`, oldest-first).
- The first two `strace` attempts traced a process that did not serve the load (tiny counts, no
  `writev`); the third produced a valid trace. What changed between them was not recorded here (a wrapper process traced without `-f` is one possible cause of the failures; a leftover server on the port is another).

### Scaling note (not comparable to the runs above)

An 8s-window matrix on the same Codespace (counters cumulative across scenarios, windows include
ramp-up): N=50 and N=100 pass every gate; N=200 fails tick p95 (65-67ms), tick p99 (79ms) and
event-loop p99 (110-169ms), with long windows' median tick 43-50ms, so at 200 the tick itself
grows, not only the burst. Still no emit or GC pause of 20ms.

### Gate status

Event-loop p99 <= 50ms remains failing at N=100 (59-72ms). Every other N=100 gate passes (tick
p95/p99, corrections, survival, occupancy, join latency, RSS). No threshold was changed.

### Open

- Whether sending fewer packets per socket per tick (~22 now, many of them 98-byte single-recipient
  `proximity:update`) would cut the burst. That changes what clients receive: a protocol/behavior
  change that needs its own plan, evidence, and a check of what the web client handles.
- A run with the harness on a separate machine.
- N=200 tick scaling (tick p50 4.0ms -> 14.9ms from N=100 to N=200 in the 8s matrix).
- RSS plateau (~70MB per room), tick p95 marginal (24.8 vs 25 in one run; ~2ms is instrument
  overhead), post-rejoin first-move snap-back, admit-during-eviction window.

### Tools added (read-only)

`analyze-stalls` (result JSON overlap report), `analyze-profile` (`.cpuprofile`: busy time inside
vs after each tick, by library, `--callers=<fn>`), the load harness's reconnect churn
(`LOAD_HARNESS_RECONNECT_COUNT`), emit-tail and GC recorders exposed on `/internal/metrics`.

## Phase 18: proximity batching, Phase 1 (server + shared + harness clients)

Opt-in: a client declares `proximityBatch: true` in `join_room` and receives one `proximity:batch`
per tick instead of one `proximity:update` per change. The existing dedup still decides what is an
update; only the framing changes. The flag is stored on the peer record next to the socket id, so a
reconnect re-declares it. `PROXIMITY_BATCH=off` makes the server ignore every opt-in. The web client
does not opt in yet (Phase 2), so no real user is affected.

Codespace A, N=100, 60s, spread, 20 reconnects, co-located, fresh server, harness opted in. The
baselines are the two earlier per-peer runs (different commits, not a back-to-back run).

| | per-peer run A | per-peer run B | batched |
|---|---|---|---|
| post-tick burst p50 / p90 / p99 | 23.2 / 31.6 / 42.0 ms | 22.8 / 31.5 / 41.9 ms | **1.6 / 2.9 / 7.7 ms** |
| windows with tick+burst >= 50ms | 56/400 | 49/400 | **0/400** |
| event-loop p99 (median / worst) | 62.21 / 66.78 ms | 59.13 / 64.98 ms | **24.73 / 26.18 ms** |
| tick p50 / p95 / p99 | 16.8 / 22.8 / 27.2 ms | 15.4 / 21.7 / 27.9 ms | 11.1 / 15.2 / 18.0 ms |
| audioEmit phase | 11.9 ms | 10.8 ms | 6.2 ms |
| server CPU, % of one core (median) | 43.6 | 42.3 | 20.2 |
| emit calls | 1,403,256 | 1,248,379 | 63,298 (59,114 batch frames) |

- Delivery validity: the server queued 1,329,900 updates and clients received 1,329,900 (22.5 per
  frame): received/sent 1.0000. That volume matches the earlier runs' ~1.25-1.4M emit calls, so the
  workload is comparable.
- The event-loop p99 tracks tick + burst as the earlier reading predicted (before: ~63-66ms against
  59-62ms; now: 22.3ms against 24.7ms).
- Other gates and corrections unchanged (3 corrections, 0.0053%; occupancy 100 after 20 reconnects).
- Observed, not explained: RSS ended at 341MB (262 -> 341, last interval +32MB) against 197 -> 266
  in an earlier run; minor GC pauses were fewer but longer (max 10.2ms, 8 at or above 5ms; total
  265ms against ~170-185ms). No pause reached 20ms. One run each.
- Not established: cost on the client side (the harness client parses one event per tick; the web
  client is Phase 2), behavior with clients on another machine (loopback caveat stands), and the
  flag-off path on this commit under load (covered by tests and a local smoke only).
