/** Pure aggregation of a V8 .cpuprofile: where the main thread's busy time went,
 *  split into "inside the room tick" and "outside it" (the post-tick burst), by
 *  library. Numbers only, no verdict text. */

export interface CpuProfile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber?: number };
    children?: number[];
  }[];
  samples: number[];
  timeDeltas: number[];
}

export type Group = "socketio" | "engineio" | "ws" | "app" | "gc" | "node" | "otherDeps";

export interface Bucket {
  totalMs: number;
  byGroup: Partial<Record<Group, number>>;
  /** Self time per "function (url:line)". */
  byFunction: Record<string, number>;
}

export interface ProfileSummary {
  hasTick: boolean;
  idleMs: number;
  insideTick: Bucket;
  outsideTick: Bucket;
}

function groupOf(fn: string, url: string): Group {
  if (fn === "(garbage collector)") return "gc";
  if (url.includes("/socket.io") || url.includes("socket.io-")) return "socketio";
  if (url.includes("/engine.io")) return "engineio";
  if (url.includes("/node_modules/ws/")) return "ws";
  if (url.includes("/node_modules/")) return "otherDeps";
  if (url === "" || url.startsWith("node:")) return "node";
  return "app";
}

const isTickFrame = (fn: string, url: string) => fn === "tick" && url.includes("roomManager");

export function summarizeProfile(profile: CpuProfile): ProfileSummary {
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

  const empty = (): Bucket => ({ totalMs: 0, byGroup: {}, byFunction: {} });
  const out: ProfileSummary = { hasTick: false, idleMs: 0, insideTick: empty(), outsideTick: empty() };

  for (let i = 0; i < profile.samples.length; i++) {
    const node = byId.get(profile.samples[i]!);
    if (!node) continue;
    const ms = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i] ?? 0) / 1000;
    const { functionName: fn, url, lineNumber } = node.callFrame;
    if (fn === "(idle)") {
      out.idleMs += ms;
      continue;
    }
    const tick = inTick(node.id);
    if (tick) out.hasTick = true;
    const bucket = tick ? out.insideTick : out.outsideTick;
    const g = groupOf(fn, url);
    bucket.totalMs += ms;
    bucket.byGroup[g] = (bucket.byGroup[g] ?? 0) + ms;
    const key = `${fn || "(anonymous)"} (${url.replace(/^.*node_modules\//, "").replace(/^file:\/\/.*\/dist\//, "dist/") || "native"}${lineNumber != null && lineNumber >= 0 ? ":" + (lineNumber + 1) : ""})`;
    bucket.byFunction[key] = (bucket.byFunction[key] ?? 0) + ms;
  }
  return out;
}
