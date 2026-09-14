import { describe, it, expect, beforeEach } from "vitest";
import { proximityStore } from "../proximityStore";

describe("proximityStore", () => {
  beforeEach(() => proximityStore.getState().clear());

  it("setPeerProximity records desired audio state for a peer", () => {
    proximityStore.getState().setPeerProximity("u1", { audioSubscribed: true, audioGain: 0.7 });
    expect(proximityStore.getState().desired.get("u1")).toEqual({ audioSubscribed: true, audioGain: 0.7 });
  });

  it("pruneToRoster drops entries for peers no longer in the roster", () => {
    proximityStore.getState().setPeerProximity("u1", { audioSubscribed: true, audioGain: 1 });
    proximityStore.getState().setPeerProximity("u2", { audioSubscribed: true, audioGain: 1 });

    proximityStore.getState().pruneToRoster(new Set(["u1"]));

    const desired = proximityStore.getState().desired;
    expect(desired.has("u1")).toBe(true);
    expect(desired.has("u2")).toBe(false);
  });

  it("pruneToRoster is a no-op (does not allocate a new map) when nothing needs dropping", () => {
    proximityStore.getState().setPeerProximity("u1", { audioSubscribed: true, audioGain: 1 });
    const before = proximityStore.getState().desired;

    proximityStore.getState().pruneToRoster(new Set(["u1", "u2"]));

    expect(proximityStore.getState().desired).toBe(before);
  });

  it("removePeer drops a single peer's desired state (peers:delta.left or ParticipantDisconnected)", () => {
    proximityStore.getState().setPeerProximity("u1", { audioSubscribed: true, audioGain: 1 });
    proximityStore.getState().removePeer("u1");
    expect(proximityStore.getState().desired.has("u1")).toBe(false);
  });

  it("removePeer for an unknown peer does nothing and does not allocate a new map", () => {
    const before = proximityStore.getState().desired;
    proximityStore.getState().removePeer("ghost");
    expect(proximityStore.getState().desired).toBe(before);
  });

  it("regression: a rejoining peer's fresh proximity:update overwrites stale prior state", () => {
    // Mirrors the server-side roomManager fix — the client side must not
    // hold onto stale desired-audio state across a peer leaving and
    // rejoining either.
    proximityStore.getState().setPeerProximity("u2", { audioSubscribed: true, audioGain: 1 });
    proximityStore.getState().removePeer("u2");
    expect(proximityStore.getState().desired.has("u2")).toBe(false);

    proximityStore.getState().setPeerProximity("u2", { audioSubscribed: false, audioGain: 0 });
    expect(proximityStore.getState().desired.get("u2")).toEqual({ audioSubscribed: false, audioGain: 0 });
  });
});
