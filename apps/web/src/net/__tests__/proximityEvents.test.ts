import { describe, it, expect, beforeEach } from "vitest";
import { proximityStore } from "@/store/proximityStore";
import {
  applyProximityUpdate,
  applyProximityBatch,
  proximityEventStats,
  resetProximityEventStats,
} from "../proximityEvents";

const item = (peerId: string, audioGain = 0.5, audioSubscribed = true) => ({
  peerId,
  audioSubscribed,
  audioGain,
  videoSubscribed: false,
});

describe("proximity event handlers", () => {
  beforeEach(() => {
    proximityStore.getState().clear();
    resetProximityEventStats();
  });

  describe("applyProximityUpdate (legacy, one peer per event)", () => {
    it("writes the peer's desired audio state", () => {
      expect(applyProximityUpdate(item("u1", 0.7))).toBe(true);
      expect(proximityStore.getState().desired.get("u1")).toEqual({ audioSubscribed: true, audioGain: 0.7 });
    });

    it("ignores an invalid payload without touching the store", () => {
      const before = proximityStore.getState().desired;
      expect(applyProximityUpdate({ peerId: "", audioGain: 5 })).toBe(false);
      expect(proximityStore.getState().desired).toBe(before);
    });
  });

  describe("applyProximityBatch", () => {
    it("applies every valid item with a single store notification", () => {
      let notifications = 0;
      const unsubscribe = proximityStore.subscribe(() => notifications++);
      const result = applyProximityBatch({ updates: [item("u1", 0.2), item("u2", 0.9), item("u3", 1)] });
      unsubscribe();

      expect(result).toEqual({ applied: 3, dropped: 0 });
      expect(notifications).toBe(1);
      const desired = proximityStore.getState().desired;
      expect(desired.get("u1")).toEqual({ audioSubscribed: true, audioGain: 0.2 });
      expect(desired.get("u2")).toEqual({ audioSubscribed: true, audioGain: 0.9 });
      expect(desired.get("u3")).toEqual({ audioSubscribed: true, audioGain: 1 });
    });

    it("applies the valid items and drops and counts the invalid ones", () => {
      const result = applyProximityBatch({
        updates: [item("u1"), { peerId: "u2", audioSubscribed: true, audioGain: 9, videoSubscribed: false }, item("u3"), "junk"],
      });

      expect(result).toEqual({ applied: 2, dropped: 2 });
      expect(proximityEventStats.droppedItems).toBe(2);
      const desired = proximityStore.getState().desired;
      expect([...desired.keys()].sort()).toEqual(["u1", "u3"]);
    });

    it("does nothing for an empty batch (no store notification)", () => {
      let notifications = 0;
      const unsubscribe = proximityStore.subscribe(() => notifications++);
      expect(applyProximityBatch({ updates: [] })).toEqual({ applied: 0, dropped: 0 });
      unsubscribe();
      expect(notifications).toBe(0);
    });

    it("ignores a payload that is not a batch at all, counting nothing as applied", () => {
      const before = proximityStore.getState().desired;
      expect(applyProximityBatch(null)).toEqual({ applied: 0, dropped: 0 });
      expect(applyProximityBatch({ updates: "nope" })).toEqual({ applied: 0, dropped: 0 });
      expect(applyProximityBatch(42)).toEqual({ applied: 0, dropped: 0 });
      expect(proximityStore.getState().desired).toBe(before);
    });

    it("when a peer appears twice in one batch, the later item wins", () => {
      applyProximityBatch({ updates: [item("u1", 0.1), item("u1", 0.8)] });
      expect(proximityStore.getState().desired.get("u1")).toEqual({ audioSubscribed: true, audioGain: 0.8 });
    });

    it("keeps state for peers the batch does not mention", () => {
      applyProximityUpdate(item("u9", 0.4));
      applyProximityBatch({ updates: [item("u1")] });
      expect(proximityStore.getState().desired.get("u9")).toEqual({ audioSubscribed: true, audioGain: 0.4 });
    });
  });
});
