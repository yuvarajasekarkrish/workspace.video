import { describe, it, expect } from "vitest";
import {
  MoveEventSchema,
  JoinRoomEventSchema,
  ObjectUpsertEventSchema,
  ProximityUpdateEventSchema,
  ProximityBatchEventSchema,
  ServerEvents,
} from "../events.js";

describe("event schemas", () => {
  it("accepts a well-formed move event", () => {
    const result = MoveEventSchema.safeParse({ position: { x: 1, y: 2 }, clientTs: Date.now() });
    expect(result.success).toBe(true);
  });

  it("rejects a move event with non-finite coordinates", () => {
    const result = MoveEventSchema.safeParse({ position: { x: NaN, y: 2 }, clientTs: 1 });
    expect(result.success).toBe(false);
  });

  it("rejects a join event with an empty roomId", () => {
    const result = JoinRoomEventSchema.safeParse({ roomId: "" });
    expect(result.success).toBe(false);
  });

  it("defaults optional fields on an object upsert", () => {
    const result = ObjectUpsertEventSchema.safeParse({
      objectId: "obj1",
      roomId: "room1",
      type: "note",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      baseVersion: 0,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rotation).toBe(0);
      expect(result.data.data).toEqual({});
    }
  });

  it("rejects an unknown canvas object type", () => {
    const result = ObjectUpsertEventSchema.safeParse({
      objectId: "obj1",
      roomId: "room1",
      type: "not-a-real-type",
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      baseVersion: 0,
    });
    expect(result.success).toBe(false);
  });

  it("clamps proximity gain to [0,1] at the schema level", () => {
    const result = ProximityUpdateEventSchema.safeParse({
      peerId: "p1",
      audioSubscribed: true,
      audioGain: 1.5,
      videoSubscribed: false,
    });
    expect(result.success).toBe(false);
  });

  describe("proximity batching (opt-in)", () => {
    it("treats a join without proximityBatch as not opted in", () => {
      const parsed = JoinRoomEventSchema.safeParse({ roomId: "r1" });
      expect(parsed.success).toBe(true);
      expect(parsed.success && parsed.data.proximityBatch).toBeUndefined();
    });

    it("accepts proximityBatch true and false, rejects a non-boolean", () => {
      expect(JoinRoomEventSchema.safeParse({ roomId: "r1", proximityBatch: true }).success).toBe(true);
      expect(JoinRoomEventSchema.safeParse({ roomId: "r1", proximityBatch: false }).success).toBe(true);
      expect(JoinRoomEventSchema.safeParse({ roomId: "r1", proximityBatch: "yes" }).success).toBe(false);
    });

    it("carries proximity updates in the same item shape as proximity:update", () => {
      const item = { peerId: "p1", audioSubscribed: true, audioGain: 0.5, videoSubscribed: false };
      expect(ProximityBatchEventSchema.safeParse({ updates: [item, { ...item, peerId: "p2" }] }).success).toBe(true);
      expect(ProximityBatchEventSchema.safeParse({ updates: [] }).success).toBe(true);
      expect(ProximityBatchEventSchema.safeParse({ updates: [{ ...item, audioGain: 1.5 }] }).success).toBe(false);
      expect(ProximityBatchEventSchema.safeParse({ updates: [{ peerId: "" }] }).success).toBe(false);
    });

    it("names the event proximity:batch", () => {
      expect(ServerEvents.ProximityBatch).toBe("proximity:batch");
    });
  });
});
