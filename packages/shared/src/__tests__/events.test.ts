import { describe, it, expect } from "vitest";
import {
  MoveEventSchema,
  JoinRoomEventSchema,
  ObjectUpsertEventSchema,
  ProximityUpdateEventSchema,
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
});
