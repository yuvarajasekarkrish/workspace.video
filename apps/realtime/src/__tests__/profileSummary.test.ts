import { describe, it, expect } from "vitest";
import { groupOf, summarizeProfile, type CpuProfile } from "../profileSummary.js";

const frame = (functionName: string, url = "") => ({ functionName, url });

// root -> tick(roomManager) -> emit(socket.io)
//      -> onData(engine.io)          (outside the tick)
//      -> (program)                  (native time)
//      -> (idle)
const nodes: CpuProfile["nodes"] = [
  { id: 1, callFrame: frame("(root)"), children: [2, 4, 5, 6] },
  { id: 2, callFrame: frame("tick", "file:///app/dist/roomManager.js"), children: [3] },
  { id: 3, callFrame: frame("emit", "file:///app/node_modules/socket.io/dist/socket.js") },
  { id: 4, callFrame: frame("onData", "file:///app/node_modules/engine.io/build/socket.js") },
  { id: 5, callFrame: frame("(idle)") },
  { id: 6, callFrame: frame("(program)") },
];
const EMIT = 3;
const ONDATA = 4;
const IDLE = 5;
const NATIVE = 6;

/** Builds a profile from [nodeId, ms] segments, one 1ms sample per ms. */
function timeline(segments: [number, number][]): CpuProfile {
  const samples: number[] = [];
  for (const [id, ms] of segments) for (let i = 0; i < ms; i++) samples.push(id);
  return { nodes, samples, timeDeltas: samples.map(() => 1000) };
}

describe("groupOf", () => {
  const cases: [string, string, string, string][] = [
    ["(garbage collector)", "", "gc", "gc"],
    ["(program)", "", "program", "libuv/syscall time"],
    ["stringify", "", "builtin", "V8 builtin with no script url"],
    ["send", "file:///a/node_modules/ws/lib/sender.js", "ws", "ws"],
    ["emit", "file:///a/node_modules/socket.io/dist/socket.js", "socketio", "socket.io"],
    ["parse", "file:///a/node_modules/socket.io-parser/dist/index.js", "socketio", "socket.io-parser"],
    ["onData", "file:///a/node_modules/engine.io/build/socket.js", "engineio", "engine.io"],
    ["query", "file:///a/node_modules/ioredis/built/Redis.js", "otherDeps", "other dependency"],
    ["tick", "file:///a/dist/roomManager.js", "app", "app code"],
    ["afterWriteDispatched", "node:internal/stream_base_commons", "netStream", "stream_base_commons (write completion)"],
    ["writeGeneric", "node:internal/stream_base_commons", "netStream", "stream_base_commons"],
    ["onwrite", "node:internal/streams/writable", "netStream", "streams/writable"],
    ["Socket._writeGeneric", "node:net", "netStream", "net"],
    ["emit", "node:events", "nodeOther", "events"],
    ["processTicksAndRejections", "node:internal/process/task_queues", "nodeOther", "task_queues"],
  ];
  it.each(cases)("%s (%s) -> %s [%s]", (fn, url, group) => {
    expect(groupOf(fn, url)).toBe(group);
  });
});

describe("summarizeProfile", () => {
  it("splits busy time into inside and outside the tick, by library, and keeps idle apart", () => {
    const s = summarizeProfile(timeline([[EMIT, 4], [ONDATA, 6], [IDLE, 6]]));
    expect(s.hasTick).toBe(true);
    expect(s.insideTick.byGroup.socketio).toBeCloseTo(4, 5);
    expect(s.outsideTick.byGroup.engineio).toBeCloseTo(6, 5);
    expect(s.outsideTick.byGroup.socketio ?? 0).toBe(0);
    expect(s.idleMs).toBeCloseTo(6, 5);
    expect(s.insideTick.totalMs + s.outsideTick.totalMs).toBeCloseTo(10, 5);
  });

  it("reports no tick for a profile without roomManager frames", () => {
    const s = summarizeProfile({
      nodes: [{ id: 1, callFrame: frame("(root)"), children: [2] }, { id: 2, callFrame: frame("x", "file:///a/dist/other.js") }],
      samples: [2],
      timeDeltas: [1000],
    });
    expect(s.hasTick).toBe(false);
  });
});

describe("summarizeProfile: the busy run after each tick", () => {
  it("measures only the run following each tick, not startup or other outside-tick work", () => {
    const s = summarizeProfile(
      timeline([
        [ONDATA, 5], // startup noise, before any tick
        [IDLE, 10],
        [EMIT, 15], // tick 1
        [ONDATA, 6], // burst 1
        [NATIVE, 4],
        [IDLE, 5],
        [EMIT, 15], // tick 2
        [ONDATA, 3], // burst 2
        [IDLE, 3],
      ]),
    );
    expect(s.postTick.runMs).toEqual([10, 3]);
    expect(s.postTick.bucket.byGroup.engineio).toBeCloseTo(9, 5);
    expect(s.postTick.bucket.byGroup.program).toBeCloseTo(4, 5);
    expect(s.postTick.bucket.totalMs).toBeCloseTo(13, 5);
    // The whole-run outside-tick bucket still contains the startup 5ms.
    expect(s.outsideTick.byGroup.engineio).toBeCloseTo(14, 5);
  });

  it("keeps a single idle sample inside the run, but ends it at an idle gap of 2ms or more", () => {
    const s = summarizeProfile(timeline([[EMIT, 10], [ONDATA, 2], [IDLE, 1], [ONDATA, 2], [IDLE, 5], [ONDATA, 7]]));
    expect(s.postTick.runMs).toEqual([5]); // 2 + 1 idle + 2; the later 7ms is not a burst
    expect(s.postTick.bucket.totalMs).toBeCloseTo(4, 5); // idle is not busy time
  });

  it("ends the run at the next tick when there is no idle gap", () => {
    const s = summarizeProfile(timeline([[EMIT, 10], [ONDATA, 8], [EMIT, 10], [IDLE, 3]]));
    expect(s.postTick.runMs).toEqual([8, 0]);
  });

  it("reports an empty result when the profile has no tick", () => {
    const s = summarizeProfile(timeline([[ONDATA, 5]]));
    expect(s.postTick.runMs).toEqual([]);
    expect(s.postTick.bucket.totalMs).toBe(0);
  });
});

describe("summarizeProfile: callers of a function in the post-tick runs", () => {
  // root -> tick -> emit
  //      -> processTicksAndRejections -> uncork -> writev     (post-tick flush)
  //      -> setup -> writev                                    (startup, not in a post-tick run)
  const n: CpuProfile["nodes"] = [
    { id: 1, callFrame: frame("(root)"), children: [2, 4, 7, 8] },
    { id: 2, callFrame: frame("tick", "file:///app/dist/roomManager.js"), children: [3] },
    { id: 3, callFrame: frame("emit", "file:///app/node_modules/socket.io/dist/socket.js") },
    { id: 4, callFrame: frame("processTicksAndRejections", "node:internal/process/task_queues"), children: [5] },
    { id: 5, callFrame: frame("uncork", "node:internal/streams/writable"), children: [6] },
    { id: 6, callFrame: frame("writev") },
    { id: 7, callFrame: frame("(idle)") },
    { id: 8, callFrame: frame("setup", "file:///app/dist/server.js"), children: [9] },
    { id: 9, callFrame: frame("writev") },
  ];
  const build = (segments: [number, number][]): CpuProfile => {
    const samples: number[] = [];
    for (const [id, ms] of segments) for (let i = 0; i < ms; i++) samples.push(id);
    return { nodes: n, samples, timeDeltas: samples.map(() => 1000) };
  };

  it("groups the named function's post-tick time by caller chain, leaf first", () => {
    const s = summarizeProfile(build([[9, 4], [7, 5], [3, 10], [6, 8], [7, 5]]), { callersOf: "writev" });
    expect(s.postTick.callers).toEqual({ "writev < uncork < processTicksAndRejections < (root)": 8 });
  });

  it("leaves callers empty when not requested", () => {
    const s = summarizeProfile(build([[3, 10], [6, 8], [7, 5]]));
    expect(s.postTick.callers).toEqual({});
  });
});
