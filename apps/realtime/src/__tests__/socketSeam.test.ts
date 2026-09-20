import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server as SocketIOServer } from "socket.io";
import { io as ioClient, type Socket as ClientSocket } from "socket.io-client";
import type { RoomLease } from "@workspace-video/realtime-core";
import { ClientEvents, ServerEvents, ProximityBatchEventSchema } from "@workspace-video/shared";
import { RoomManager, broadcasterFromSocketServer } from "../roomManager.js";
import { registerSocketHandlers } from "../socketHandlers.js";
import type { ObjectRepository } from "../objectPersistence.js";
import { EmitTailRecorder } from "../emitTailRecorder.js";

const ROOM_ID = "room1";
const WORKSPACE_ID = "ws1";

/** Real Socket.IO server on an ephemeral port with no Redis adapter, real
 *  RoomManager, real socket.io-client connections. Only the external
 *  dependencies (lease, membership, session tokens, participant limit) are
 *  faked — the join/disconnect wiring under test is the real thing. */
async function startSeam(objectRepository?: ObjectRepository, emitTail?: EmitTailRecorder) {
  const httpServer: HttpServer = createServer();
  const io = new SocketIOServer(httpServer);
  const lease = {
    refresh: vi.fn().mockResolvedValue("renewed"),
    claimOrRead: vi.fn().mockResolvedValue("instance-a"),
    release: vi.fn(),
    currentOwner: vi.fn(),
  } as unknown as RoomLease;
  const roomManager = new RoomManager(broadcasterFromSocketServer(io), lease, "instance-a", 10_000, objectRepository);

  registerSocketHandlers({
    io,
    roomManager,
    roomLease: lease,
    authSecret: "unused",
    instanceId: "instance-a",
    joinDuration: { record: () => {} },
    disconnectReasonCounts: {},
    emitTail,
    loadHarnessLimitOverride: { getWorkspaceParticipantLimit: async () => 100 },
    auth: {
      // The token IS the userId — keeps tests readable.
      verifySessionToken: (token: string) => ({ userId: token, email: `${token}@test` }),
      assertRoomMembership: async () => ({ workspaceId: WORKSPACE_ID, config: {} }),
      assertWorkspaceMembership: async () => {},
    } as never,
  });

  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return { httpServer, io, roomManager, url: `http://127.0.0.1:${port}` };
}

async function waitFor(predicate: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("socket seam", () => {
  let seam: Awaited<ReturnType<typeof startSeam>> | undefined;
  const clients: ClientSocket[] = [];

  afterEach(async () => {
    for (const c of clients) c.disconnect();
    clients.length = 0;
    await seam?.roomManager.disposeAll();
    await new Promise<void>((resolve) => {
      if (!seam) return resolve();
      seam.io.close(() => resolve());
    });
    seam = undefined;
  });

  async function connect(userId: string): Promise<ClientSocket> {
    const client = ioClient(seam!.url, { auth: { token: userId }, reconnection: false, transports: ["websocket"] });
    clients.push(client);
    await new Promise<void>((resolve, reject) => {
      client.once("connect", () => resolve());
      client.once("connect_error", reject);
    });
    return client;
  }

  function join(client: ClientSocket): Promise<unknown> {
    return new Promise((resolve) => client.emit(ClientEvents.JoinRoom, { roomId: ROOM_ID }, resolve));
  }

  it("keeps a user in the room when their OLD socket disconnects after they re-joined on a new one", async () => {
    seam = await startSeam();

    // u1 joins on S1, then (as a browser does on reconnect) joins again on S2.
    const s1 = await connect("u1");
    expect(await join(s1)).toEqual({ ok: true });
    const s2 = await connect("u1");
    expect(await join(s2)).toEqual({ ok: true });

    // A different user, so we can see what the rest of the room is told.
    const observer = await connect("u2");
    const observed: { left: string[] }[] = [];
    observer.on(ServerEvents.PeersDelta, (p: { left: string[] }) => observed.push(p));
    expect(await join(observer)).toEqual({ ok: true });
    observed.length = 0;

    // The dead socket S1 finally goes away (in production: ping timeout).
    s1.disconnect();
    await waitFor(() => seam!.io.sockets.sockets.size === 2, "server to drop S1");
    // Give the async removePeer path a chance to run to its emits.
    await new Promise((r) => setTimeout(r, 50));

    const peers = seam.roomManager.snapshot(ROOM_ID).map((p) => p.userId);
    expect(peers, "u1 must still be a peer: S2 is their live socket").toContain("u1");
    expect(
      observed.flatMap((d) => d.left),
      "the room must not be told u1 left",
    ).not.toContain("u1");

    // And u1's live socket can still move.
    const before = seam.roomManager.snapshot(ROOM_ID).find((p) => p.userId === "u1")?.position;
    const target = { x: (before?.x ?? 0) + 5, y: before?.y ?? 0 };
    s2.emit(ClientEvents.Move, { position: target, clientTs: Date.now() });
    await new Promise((r) => setTimeout(r, 50));
    const after = seam.roomManager.snapshot(ROOM_ID).find((p) => p.userId === "u1")?.position;
    expect(after, "a move from the live socket must be accepted").toEqual(target);
    expect(seam.roomManager.getStaleDisconnectsIgnored(), "the guard must be observable in metrics").toBe(1);
  });

  it("times the join's direct emits, and the client still receives the same snapshots", async () => {
    const tail = new EmitTailRecorder();
    seam = await startSeam(undefined, tail);

    const s1 = await connect("u1");
    const received: string[] = [];
    for (const event of [ServerEvents.PeersSnapshot, ServerEvents.ObjectsSnapshot, ServerEvents.SeatsSnapshot]) {
      s1.on(event, () => received.push(event));
    }
    expect(await join(s1)).toEqual({ ok: true });
    await waitFor(() => received.length === 3, "the three join snapshots to arrive");

    // Behavior unchanged: the joiner got all three.
    expect(received.sort()).toEqual([ServerEvents.ObjectsSnapshot, ServerEvents.PeersSnapshot, ServerEvents.SeatsSnapshot].sort());
    // And each was timed on the direct path.
    const keys = Object.keys(tail.snapshot().byKey);
    expect(keys).toEqual(
      expect.arrayContaining([
        `direct|${ServerEvents.PeersSnapshot}`,
        `direct|${ServerEvents.ObjectsSnapshot}`,
        `direct|${ServerEvents.SeatsSnapshot}`,
      ]),
    );
  });

  it("proximity batching over real sockets: an opted-in client gets a batch, an old client keeps getting per-peer updates", async () => {
    seam = await startSeam();
    const joinWith = (client: ClientSocket, proximityBatch?: boolean) =>
      new Promise((resolve) =>
        client.emit(ClientEvents.JoinRoom, { roomId: ROOM_ID, ...(proximityBatch === undefined ? {} : { proximityBatch }) }, resolve),
      );

    const newClient = await connect("u1");
    const oldClient = await connect("u2");
    const seen = { newBatch: [] as { peerId: string }[][], newUpdate: 0, oldBatch: 0, oldUpdate: [] as string[] };
    const rawBatches: unknown[] = [];
    newClient.on(ServerEvents.ProximityBatch, (p: { updates: { peerId: string }[] }) => {
      rawBatches.push(p);
      seen.newBatch.push(p.updates);
    });
    newClient.on(ServerEvents.ProximityUpdate, () => seen.newUpdate++);
    oldClient.on(ServerEvents.ProximityBatch, () => seen.oldBatch++);
    oldClient.on(ServerEvents.ProximityUpdate, (p: { peerId: string }) => seen.oldUpdate.push(p.peerId));

    expect(await joinWith(newClient, true)).toEqual({ ok: true });
    expect(await joinWith(oldClient)).toEqual({ ok: true }); // no field at all: what every existing client sends

    await waitFor(() => seen.newBatch.length > 0 && seen.oldUpdate.length > 0, "both listeners to be told about each other");
    // The contract the web client relies on: what the server emits parses with the shared schema.
    expect(rawBatches.length).toBeGreaterThan(0);
    for (const batch of rawBatches) expect(ProximityBatchEventSchema.safeParse(batch).success).toBe(true);
    expect(seen.newBatch.flat().map((u) => u.peerId)).toEqual(["u2"]);
    expect(seen.newUpdate, "the opted-in client must not also get per-peer updates").toBe(0);
    expect(seen.oldUpdate).toEqual(["u1"]);
    expect(seen.oldBatch, "the old client must never see the new event").toBe(0);
  });

  it("does not hand a joiner a room that is mid-eviction (flush in progress)", async () => {
    const FLUSH_MS = 150;
    const repository: ObjectRepository = {
      loadRoomObjects: async () => [],
      upsertObject: async () => {
        await new Promise((r) => setTimeout(r, FLUSH_MS));
      },
      deleteObject: async () => {},
    };
    seam = await startSeam(repository);

    // u1 leaves a pending object write behind, so evicting the emptied room
    // has a real, slow flush to await.
    const s1 = await connect("u1");
    expect(await join(s1)).toEqual({ ok: true });
    const upsertAck = await new Promise((resolve) =>
      s1.emit(
        ClientEvents.ObjectUpsert,
        { objectId: "o1", roomId: ROOM_ID, type: "note", x: 0, y: 0, width: 100, height: 100, data: {}, baseVersion: 0 },
        resolve,
      ),
    );
    expect(upsertAck).toEqual({ ok: true });

    // u2 is connected but has not joined yet.
    const s2 = await connect("u2");

    // The last peer leaves: the room empties and eviction starts its slow flush.
    s1.disconnect();
    await waitFor(() => seam!.io.sockets.sockets.size === 1, "server to drop u1");

    // A join lands while that flush is still in flight.
    expect(await join(s2)).toEqual({ ok: true });

    // Let the flush finish and eviction complete.
    await new Promise((r) => setTimeout(r, FLUSH_MS + 100));

    const peers = seam.roomManager.snapshot(ROOM_ID).map((p) => p.userId);
    expect(peers, "u2 joined during the flush and must end up in a live room").toContain("u2");
    expect(seam.roomManager.isOwnedLocally(ROOM_ID), "the room u2 is in must still exist").toBe(true);
  });
});
