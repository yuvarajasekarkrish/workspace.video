import { describe, it, expect } from "vitest";
import { EmitTailRecorder } from "../emitTailRecorder.js";
import { GcRecorder } from "../gcRecorder.js";
import { formatStallReport } from "../stallReport.js";

describe("formatStallReport", () => {
  it("prints the tail table, the slowest ops, GC and the stalled/control rows with real numbers", () => {
    let t = 0;
    const tail = new EmitTailRecorder(() => t);
    tail.time("peers:snapshot", "direct", () => void (t += 62), { recipients: () => 100, payload: { x: 1 } });
    tail.time("proximity:update", "room", () => void (t += 1));
    const gc = new GcRecorder();
    gc.supported = true;
    gc.record({ startTime: 10, duration: 33, detail: { kind: 4 } });

    const lines = formatStallReport({
      windows: [{ atMs: 100, windowMs: 100, tickMs: 15, postTickMs: 60, emitMs: 3 }],
      emitTail: tail.snapshot(),
      gc: gc.snapshot(),
    });
    const text = lines.join("\n");
    expect(text).toContain("direct|peers:snapshot");
    expect(text).toContain("slowest: 62.0ms direct|peers:snapshot recipients=100");
    expect(text).toContain("observer supported: yes");
    expect(text).toContain("longest: 33.0ms major");
    expect(text).toContain("long (tick+burst >= 50)");
    expect(text).toContain("control (tick+burst < 50)");
    expect(text).toContain("post-tick burst");
    expect(text).toContain("windows >= 50ms: 1/1");
    // No verdict language, only figures.
    expect(text).not.toMatch(/proves|caused by|the cause/i);
  });

  it("prints nothing for missing inputs instead of throwing", () => {
    expect(formatStallReport({ windows: [] })).toEqual([]);
  });
});
