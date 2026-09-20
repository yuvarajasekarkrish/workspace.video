import { describe, it, expect } from "vitest";
import { summarizeProfile, type CpuProfile } from "../profileSummary.js";

const frame = (functionName: string, url = "") => ({ functionName, url });

// root -> tick(roomManager) -> emit(socket.io)
//      -> onData(engine.io)          (outside the tick)
//      -> (idle)
const nodes: CpuProfile["nodes"] = [
  { id: 1, callFrame: frame("(root)"), children: [2, 4, 5] },
  { id: 2, callFrame: frame("tick", "file:///app/dist/roomManager.js"), children: [3] },
  { id: 3, callFrame: frame("emit", "file:///app/node_modules/socket.io/dist/socket.js") },
  { id: 4, callFrame: frame("onData", "file:///app/node_modules/engine.io/build/socket.js") },
  { id: 5, callFrame: frame("(idle)") },
];

describe("summarizeProfile", () => {
  it("splits busy time into inside and outside the tick, by library, and keeps idle apart", () => {
    // A sample lasts until the next one: emit 4ms, onData 6ms, idle 90ms (last sample reuses its own delta).
    const s = summarizeProfile({ nodes, samples: [3, 4, 5], timeDeltas: [1000, 4000, 6000, 90000].slice(0, 3) });
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
