/** Pure aggregation of a V8 .cpuprofile: where the main thread's busy time went,
 *  split into "inside the room tick" and "outside it", by library, and
 *  specifically for the busy run that follows each tick (the post-tick burst).
 *  Numbers only, no verdict text. */

export interface CpuProfile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber?: number };
    children?: number[];
  }[];
  samples: number[];
  timeDeltas: number[];
}

/** netStream is Node's socket write path (net, streams, stream_base_commons):
 *  where write-completion callbacks for the tick's own emits run. program is
 *  the profiler's "(program)" bucket (libuv, syscalls); builtin is a native
 *  function with no script url (JSON.stringify, Buffer ops, performance.now). */
export type Group =
  | "socketio"
  | "engineio"
  | "ws"
  | "app"
  | "gc"
  | "program"
  | "builtin"
  | "netStream"
  | "nodeOther"
  | "otherDeps";

export interface Bucket {
  totalMs: number;
  byGroup: Partial<Record<Group, number>>;
  /** Self time per "function (url:line)". */
  byFunction: Record<string, number>;
}

export interface PostTickRuns {
  /** Wall time from the end of each tick to the end of its busy run. */
  runMs: number[];
  /** Busy time by group / function over only those runs. */
  bucket: Bucket;
  /** Busy ms of options.callersOf inside the runs, by caller chain (leaf first). */
  callers: Record<string, number>;
}

export interface ProfileSummary {
  hasTick: boolean;
  idleMs: number;
  insideTick: Bucket;
  /** Every non-tick busy sample in the whole profile (startup, joins, ...). */
  outsideTick: Bucket;
  postTick: PostTickRuns;
}

const NET_STREAM = /^node:(net|stream|_stream_\w+|internal\/(stream_base_commons|streams\/|net|js_stream_socket|stream_base))/;

export function groupOf(fn: string, url: string): Group {
  if (fn === "(garbage collector)") return "gc";
  if (fn === "(program)" || fn === "(root)") return "program";
  if (url === "") return "builtin";
  if (url.includes("/socket.io") || url.includes("socket.io-")) return "socketio";
  if (url.includes("/engine.io")) return "engineio";
  if (url.includes("/node_modules/ws/")) return "ws";
  if (url.includes("/node_modules/")) return "otherDeps";
  if (NET_STREAM.test(url)) return "netStream";
  if (url.startsWith("node:")) return "nodeOther";
  return "app";
}

const isTickFrame = (fn: string, url: string) => fn === "tick" && url.includes("roomManager");

const emptyBucket = (): Bucket => ({ totalMs: 0, byGroup: {}, byFunction: {} });

function add(bucket: Bucket, fn: string, url: string, lineNumber: number | undefined, ms: number): void {
  const g = groupOf(fn, url);
  bucket.totalMs += ms;
  bucket.byGroup[g] = (bucket.byGroup[g] ?? 0) + ms;
  const where = url.replace(/^.*node_modules\//, "").replace(/^file:\/\/.*\/dist\//, "dist/") || "native";
  const line = lineNumber != null && lineNumber >= 0 ? `:${lineNumber + 1}` : "";
  const key = `${fn || "(anonymous)"} (${where}${line})`;
  bucket.byFunction[key] = (bucket.byFunction[key] ?? 0) + ms;
}

/** An idle stretch at least this long ends a post-tick busy run. */
const RUN_ENDS_AT_IDLE_MS = 2;

export function summarizeProfile(profile: CpuProfile, options: { idleGapMs?: number; callersOf?: string } = {}): ProfileSummary {
  const idleGapMs = options.idleGapMs ?? RUN_ENDS_AT_IDLE_MS;
  const parent = new Map<number, number>();
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

  const inTickCache = new Map<number, boolean>();
  const inTick = (id: number): boolean => {
    const cached = inTickCache.get(id);
    if (cached !== undefined) return cached;
    const n = byId.get(id)!;
    const result = isTickFrame(n.callFrame.functionName, n.callFrame.url) || (parent.has(id) ? inTick(parent.get(id)!) : false);
    inTickCache.set(id, result);
    return result;
  };

  const chainOf = (id: number): string => {
    const names: string[] = [];
    for (let cur: number | undefined = id; cur !== undefined && names.length < 12; cur = parent.get(cur)) {
      names.push(byId.get(cur)!.callFrame.functionName || "(anonymous)");
    }
    return names.join(" < ");
  };

  const out: ProfileSummary = {
    hasTick: false,
    idleMs: 0,
    insideTick: emptyBucket(),
    outsideTick: emptyBucket(),
    postTick: { runMs: [], bucket: emptyBucket(), callers: {} },
  };

  // A sample lasts until the next one; the last reuses its own delta.
  const durationMs = (i: number) => (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;

  // State for the busy run that follows the most recent tick.
  let runOpen = false;
  let runStartMs = 0; // wall time at the end of the tick, relative to profile start
  let runLastBusyEndMs = 0;
  let idleStreakMs = 0;
  let clockMs = 0;
  let prevWasTick = false;
  const closeRun = () => {
    if (runOpen) out.postTick.runMs.push(runLastBusyEndMs - runStartMs);
    runOpen = false;
    idleStreakMs = 0;
  };

  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]!);
    const ms = durationMs(i);
    const startMs = clockMs;
    clockMs += ms;
    if (!node) continue;
    const { functionName: fn, url, lineNumber } = node.callFrame;

    if (fn === "(idle)") {
      prevWasTick = false;
      out.idleMs += ms;
      if (runOpen) {
        idleStreakMs += ms;
        if (idleStreakMs >= idleGapMs) closeRun();
      }
      continue;
    }

    if (inTick(node.id)) {
      out.hasTick = true;
      if (!prevWasTick) closeRun(); // a tick starting ends the previous run
      prevWasTick = true;
      add(out.insideTick, fn, url, lineNumber, ms);
      runOpen = true; // (re)opened at every tick sample; the last one sets the tick end
      runStartMs = clockMs;
      runLastBusyEndMs = clockMs;
      idleStreakMs = 0;
      continue;
    }

    prevWasTick = false;
    add(out.outsideTick, fn, url, lineNumber, ms);
    if (runOpen) {
      add(out.postTick.bucket, fn, url, lineNumber, ms);
      if (options.callersOf && fn === options.callersOf) {
        const chain = chainOf(node.id);
        out.postTick.callers[chain] = (out.postTick.callers[chain] ?? 0) + ms;
      }
      runLastBusyEndMs = startMs + ms;
      idleStreakMs = 0;
    }
  }
  closeRun();
  return out;
}
