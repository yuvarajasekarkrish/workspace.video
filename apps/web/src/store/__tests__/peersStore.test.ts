import { describe, it, expect, beforeEach } from "vitest";
import { peersStore, selectRoster, rosterEquals } from "../peersStore";

describe("peersStore", () => {
  beforeEach(() => peersStore.getState().clear());

  it("applySnapshot populates the roster and marks the local user", () => {
    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
      { userId: "u2", name: "Bo", avatarUrl: null, position: { x: 10, y: 10 } },
    ]);

    const state = peersStore.getState();
    expect(state.peers.size).toBe(2);
    expect(state.peers.get("u1")?.isLocal).toBe(true);
    expect(state.peers.get("u2")?.isLocal).toBe(false);
  });

  it("applySnapshot preserves an existing peer's renderPosition (no visual snap on resync)", () => {
    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
    ]);
    // Simulate the ticker having mid-flight-interpolated the render position.
    const midFlight = peersStore.getState().peers.get("u1")!.renderPosition;
    midFlight.x = 42;

    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 100, y: 100 } },
    ]);

    expect(peersStore.getState().peers.get("u1")?.renderPosition.x).toBe(42);
    expect(peersStore.getState().peers.get("u1")?.position).toEqual({ x: 100, y: 100 });
  });

  it("applySnapshot is a wholesale replacement — a peer missing from the new snapshot disappears", () => {
    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
      { userId: "u2", name: "Bo", avatarUrl: null, position: { x: 0, y: 0 } },
    ]);
    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
    ]);

    expect(peersStore.getState().peers.has("u2")).toBe(false);
  });

  it("applyDelta updates position without touching identity fields", () => {
    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
    ]);
    peersStore.getState().applyDelta([{ userId: "u1", position: { x: 55, y: 66 } }], []);

    const peer = peersStore.getState().peers.get("u1")!;
    expect(peer.position).toEqual({ x: 55, y: 66 });
    expect(peer.name).toBe("Ann");
  });

  it("applyDelta removes peers listed in `left`", () => {
    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
      { userId: "u2", name: "Bo", avatarUrl: null, position: { x: 0, y: 0 } },
    ]);
    peersStore.getState().applyDelta([], ["u2"]);

    expect(peersStore.getState().peers.has("u2")).toBe(false);
    expect(peersStore.getState().peers.has("u1")).toBe(true);
  });

  it("applyDelta ignores updates for unknown peers rather than fabricating one", () => {
    peersStore.getState().applySnapshot("u1", []);
    peersStore.getState().applyDelta([{ userId: "ghost", position: { x: 1, y: 1 } }], []);

    expect(peersStore.getState().peers.has("ghost")).toBe(false);
  });

  it("applyDelta introduces a brand-new peer when the update carries a name (the join-path fix)", () => {
    // This is what replaced re-sending the whole roster to everyone on every
    // join - a real load-test finding at 300 concurrent joins. A new peer
    // arrives via ONE small delta entry, not a full peers:snapshot.
    peersStore.getState().applySnapshot("u1", [
      { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 } },
    ]);
    peersStore.getState().applyDelta(
      [{ userId: "u2", position: { x: 10, y: 20 }, name: "Bo", avatarUrl: null }],
      [],
    );

    const peer = peersStore.getState().peers.get("u2");
    expect(peer).toMatchObject({ userId: "u2", name: "Bo", avatarUrl: null, position: { x: 10, y: 20 }, isLocal: false });
    // Starts settled at its authoritative position, same as a fresh snapshot entry.
    expect(peer?.renderPosition).toEqual({ x: 10, y: 20 });
  });

  it("applyDelta still ignores a position-only update for an unknown peer even when other entries in the same batch carry a name", () => {
    peersStore.getState().applySnapshot("u1", []);
    peersStore.getState().applyDelta(
      [
        { userId: "newcomer", position: { x: 1, y: 1 }, name: "New" },
        { userId: "ghost", position: { x: 2, y: 2 } }, // no name - an ordinary tick, not an introduction
      ],
      [],
    );

    expect(peersStore.getState().peers.has("newcomer")).toBe(true);
    expect(peersStore.getState().peers.has("ghost")).toBe(false);
  });
});

describe("rosterEquals", () => {
  it("treats identical rosters as equal", () => {
    const a = selectRoster({
      peers: new Map([
        ["u1", { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 }, renderPosition: { x: 0, y: 0 }, isLocal: true }],
      ]),
      localUserId: "u1",
    } as any);
    const b = selectRoster({
      peers: new Map([
        ["u1", { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 999, y: 999 }, renderPosition: { x: 0, y: 0 }, isLocal: true }],
      ]),
      localUserId: "u1",
    } as any);

    // Positions differ wildly but identity fields don't — must be equal.
    expect(rosterEquals(a, b)).toBe(true);
  });

  it("treats a changed roster membership as not equal", () => {
    const a = selectRoster({ peers: new Map(), localUserId: null } as any);
    const b = selectRoster({
      peers: new Map([
        ["u1", { userId: "u1", name: "Ann", avatarUrl: null, position: { x: 0, y: 0 }, renderPosition: { x: 0, y: 0 }, isLocal: false }],
      ]),
      localUserId: null,
    } as any);

    expect(rosterEquals(a, b)).toBe(false);
  });
});
