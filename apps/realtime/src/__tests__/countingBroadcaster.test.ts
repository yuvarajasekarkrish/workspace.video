import { describe, it, expect, vi } from "vitest";
import { CountingBroadcaster } from "../countingBroadcaster";
import { EmitTailRecorder } from "../emitTailRecorder";
import type { RoomBroadcaster } from "../roomManager";

function fakeInner(): RoomBroadcaster & { emitted: { target: string; event: string; payload: unknown }[] } {
  const emitted: { target: string; event: string; payload: unknown }[] = [];
  return {
    emitted,
    to: (target: string) => ({
      emit: (event: string, payload: unknown) => emitted.push({ target, event, payload }),
    }),
    disconnectSocketsInRoom: vi.fn(),
  };
}

describe("CountingBroadcaster with emit timing (Phase 17)", () => {
  it("passes every emit through unchanged, in order, with timing switched on", () => {
    const inner = fakeInner();
    const tail = new EmitTailRecorder();
    const counting = new CountingBroadcaster(inner, 20, { tail });
    counting.to("room1").emit("peers:delta", { a: 1 });
    counting.to("s1").emit("proximity:update", { b: 2 });
    expect(inner.emitted).toEqual([
      { target: "room1", event: "peers:delta", payload: { a: 1 } },
      { target: "s1", event: "proximity:update", payload: { b: 2 } },
    ]);
    expect(tail.snapshot().overall.count).toBe(2);
  });

  it("records a slow emit with its recipient count and payload size, and only then looks them up", () => {
    let t = 0;
    const tail = new EmitTailRecorder(() => t);
    const recipientsOf = vi.fn(() => 100);
    const slowInner: RoomBroadcaster = {
      to: () => ({ emit: () => void (t += 60) }),
      disconnectSocketsInRoom: vi.fn(),
    };
    const counting = new CountingBroadcaster(slowInner, 20, { tail, recipientsOf });
    counting.to("room1").emit("peers:snapshot", { peers: [] });

    expect(recipientsOf).toHaveBeenCalledWith("room1");
    expect(tail.snapshot().ops[0]).toMatchObject({ event: "peers:snapshot", durationMs: 60, recipients: 100, payloadBytes: 12 });

    recipientsOf.mockClear();
    const fastInner: RoomBroadcaster = { to: () => ({ emit: () => void (t += 1) }), disconnectSocketsInRoom: vi.fn() };
    new CountingBroadcaster(fastInner, 20, { tail, recipientsOf }).to("s").emit("e", {});
    expect(recipientsOf).not.toHaveBeenCalled();
  });

  it("still counts, times and rethrows the same error when the wrapped emit throws", () => {
    const boom = new Error("socket write failed");
    const throwing: RoomBroadcaster = {
      to: () => ({
        emit: () => {
          throw boom;
        },
      }),
      disconnectSocketsInRoom: vi.fn(),
    };
    const tail = new EmitTailRecorder();
    const counting = new CountingBroadcaster(throwing, 20, { tail });
    expect(() => counting.to("room1").emit("peers:delta", {})).toThrow(boom);
    expect(counting.snapshot()["peers:delta"]!.count).toBe(1);
    expect(tail.snapshot().overall.count).toBe(1);
  });
});

describe("CountingBroadcaster", () => {
  it("passes every emit through to the wrapped broadcaster unchanged", () => {
    const inner = fakeInner();
    const counting = new CountingBroadcaster(inner);
    counting.to("room1").emit("peers:delta", { foo: "bar" });
    counting.to("socket1").emit("proximity:update", { peerId: "x" });

    expect(inner.emitted).toEqual([
      { target: "room1", event: "peers:delta", payload: { foo: "bar" } },
      { target: "socket1", event: "proximity:update", payload: { peerId: "x" } },
    ]);
  });

  it("counts emits per event name, across different targets", () => {
    const counting = new CountingBroadcaster(fakeInner());
    counting.to("room1").emit("peers:delta", {});
    counting.to("room1").emit("peers:delta", {});
    counting.to("socket1").emit("proximity:update", {});

    const snapshot = counting.snapshot();
    expect(snapshot["peers:delta"]?.count).toBe(2);
    expect(snapshot["proximity:update"]?.count).toBe(1);
  });

  it("samples payload bytes at 1-in-sampleRate, not on every emit", () => {
    const counting = new CountingBroadcaster(fakeInner(), 5);
    for (let i = 0; i < 10; i++) {
      counting.to("s").emit("proximity:update", { i });
    }
    const stat = counting.snapshot()["proximity:update"]!;
    expect(stat.count).toBe(10);
    // Sampled on the 5th and 10th emit (global counter % 5 === 0) — 2 samples.
    expect(stat.sampledCount).toBe(2);
    expect(stat.sampledBytesSum).toBeGreaterThan(0);
  });

  it("forwards disconnectSocketsInRoom to the wrapped broadcaster", () => {
    const inner = fakeInner();
    const counting = new CountingBroadcaster(inner);
    counting.disconnectSocketsInRoom("room1");
    expect(inner.disconnectSocketsInRoom).toHaveBeenCalledWith("room1");
  });

  it("snapshot() returns an independent copy — later emits don't mutate a previously read snapshot", () => {
    const counting = new CountingBroadcaster(fakeInner());
    counting.to("s").emit("peers:delta", {});
    const first = counting.snapshot();
    counting.to("s").emit("peers:delta", {});
    expect(first["peers:delta"]?.count).toBe(1);
    expect(counting.snapshot()["peers:delta"]?.count).toBe(2);
  });
});
