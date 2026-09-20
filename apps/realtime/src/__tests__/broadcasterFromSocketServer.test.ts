import { describe, it, expect, vi } from "vitest";
import type { Server as SocketIOServer } from "socket.io";
import { broadcasterFromSocketServer } from "../roomManager";
import { ServerEvents } from "@workspace-video/shared";

/** Fake shaped just enough like a socket.io Server for
 *  broadcasterFromSocketServer to exercise both the cross-instance-capable
 *  `.to()` path and the local-only `.local.to()` path — a real Server would
 *  need a live redis-adapter connection to distinguish these, which this
 *  test avoids entirely. */
function fakeIo() {
  const toEmit = vi.fn();
  const localToEmit = vi.fn();
  const io = {
    to: vi.fn(() => ({ emit: toEmit })),
    local: { to: vi.fn(() => ({ emit: localToEmit })) },
    sockets: { sockets: new Map() },
  } as unknown as SocketIOServer;
  return { io, toEmit, localToEmit };
}

describe("broadcasterFromSocketServer — Phase 10 local-only tick-path emits", () => {
  it("routes peers:delta, proximity:update, and zone:changed through io.local (skips the Redis-adapter fan-out)", () => {
    const { io, localToEmit, toEmit } = fakeIo();
    const broadcaster = broadcasterFromSocketServer(io);

    broadcaster.to("room1").emit(ServerEvents.PeersDelta, { a: 1 });
    broadcaster.to("room1").emit(ServerEvents.ProximityUpdate, { b: 2 });
    broadcaster.to("socket1").emit(ServerEvents.ZoneChanged, { c: 3 });

    expect(localToEmit).toHaveBeenCalledTimes(3);
    expect(localToEmit).toHaveBeenCalledWith(ServerEvents.PeersDelta, { a: 1 });
    expect(localToEmit).toHaveBeenCalledWith(ServerEvents.ProximityUpdate, { b: 2 });
    expect(localToEmit).toHaveBeenCalledWith(ServerEvents.ZoneChanged, { c: 3 });
    expect(toEmit).not.toHaveBeenCalled();
  });

  it("routes proximity:batch through io.local too, or the tick would publish it to Redis (the Phase 10 bug)", () => {
    const { io, localToEmit, toEmit } = fakeIo();
    const broadcaster = broadcasterFromSocketServer(io);

    broadcaster.to("socket1").emit(ServerEvents.ProximityBatch, { updates: [] });

    expect(localToEmit).toHaveBeenCalledWith(ServerEvents.ProximityBatch, { updates: [] });
    expect(toEmit).not.toHaveBeenCalled();
  });

  it("routes every other event through the normal cross-instance-capable io.to path, unchanged", () => {
    const { io, localToEmit, toEmit } = fakeIo();
    const broadcaster = broadcasterFromSocketServer(io);

    broadcaster.to("room1").emit(ServerEvents.OccupancyUpdate, { active: 1, limit: 10 });
    broadcaster.to("room1").emit(ServerEvents.SeatUpdate, { seatId: "s1", userId: null });
    broadcaster.to("room1").emit(ServerEvents.ObjectSync, { object: null, accepted: true });
    broadcaster.to("room1").emit(ServerEvents.OwnerChanged, { roomId: "room1" });

    expect(toEmit).toHaveBeenCalledTimes(4);
    expect(localToEmit).not.toHaveBeenCalled();
  });
});
