import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClientEvents, ServerEvents } from "@workspace-video/shared";
import { proximityStore } from "@/store/proximityStore";
import { connectionStore } from "@/store/connectionStore";

/** A hand-written fake socket: records handlers and emits, and lets a test fire
 *  server events at the client. RealtimeClient itself had no tests before this;
 *  this only covers the proximity wiring. */
class FakeSocket {
  handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  emits: { event: string; payload: unknown }[] = [];
  on(event: string, handler: (...args: unknown[]) => void): this {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler]);
    return this;
  }
  emit(event: string, payload: unknown, ack?: (res: unknown) => void): this {
    this.emits.push({ event, payload });
    if (event === ClientEvents.JoinRoom) ack?.({ ok: true });
    return this;
  }
  removeAllListeners(): void {
    this.handlers.clear();
  }
  disconnect(): void {}
  /** Fire an event at the client as the server would. */
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
}

let socket: FakeSocket;
vi.mock("socket.io-client", () => ({ io: () => socket }));

// Imported after the mock is registered.
const { RealtimeClient } = await import("../RealtimeClient");

const item = (peerId: string, audioGain = 0.5) => ({ peerId, audioSubscribed: true, audioGain, videoSubscribed: false });

describe("RealtimeClient proximity wiring", () => {
  let client: InstanceType<typeof RealtimeClient>;

  beforeEach(async () => {
    socket = new FakeSocket();
    proximityStore.getState().clear();
    connectionStore.getState().setStatus("idle");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => ({
        ok: true,
        json: async () => (url.includes("realtime-token") ? { token: "t" } : { instanceId: "i", publicUrl: "http://fake" }),
      })),
    );
    client = new RealtimeClient("room1", "me", { onMoveCorrection: () => {} });
    await client.connect();
    socket.fire("connect");
  });

  afterEach(() => {
    client.dispose();
    vi.unstubAllGlobals();
  });

  const joins = () => socket.emits.filter((e) => e.event === ClientEvents.JoinRoom).map((e) => e.payload);

  it("opts in to proximity batching in join_room", () => {
    expect(joins()).toEqual([{ roomId: "room1", proximityBatch: true }]);
  });

  it("keeps the opt-in when the join is retried on the same socket", () => {
    client.retryJoin();
    expect(joins()).toEqual([
      { roomId: "room1", proximityBatch: true },
      { roomId: "room1", proximityBatch: true },
    ]);
  });

  it("applies a proximity:batch to the store", () => {
    socket.fire(ServerEvents.ProximityBatch, { updates: [item("u1", 0.3), item("u2", 0.8)] });
    const desired = proximityStore.getState().desired;
    expect(desired.get("u1")).toEqual({ audioSubscribed: true, audioGain: 0.3 });
    expect(desired.get("u2")).toEqual({ audioSubscribed: true, audioGain: 0.8 });
  });

  it("still applies a legacy proximity:update (old servers, or the server kill switch)", () => {
    socket.fire(ServerEvents.ProximityUpdate, item("u3", 0.6));
    expect(proximityStore.getState().desired.get("u3")).toEqual({ audioSubscribed: true, audioGain: 0.6 });
  });
});
