import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { prisma } from "../index";
import { loadRoomObjects, upsertObject, deleteObject } from "../objects";
import type { ObjectState } from "@cosmos/shared";

/**
 * Integration test against a real local Postgres (docker-compose), not a
 * mock — matching the precedent in packages/realtime-core's RoomLease tests:
 * this module's whole job is to round-trip through Postgres correctly, so a
 * fake Prisma client could accidentally "pass" without proving anything.
 * Each test gets its own randomized workspace/room/user so parallel test
 * files (and repeated runs) don't collide.
 */
describe("objects repository", () => {
  let workspaceId: string;
  let userId: string;
  let roomId: string;

  beforeAll(async () => {
    const suffix = crypto.randomUUID();
    const user = await prisma.user.create({
      data: { email: `objects-test-${suffix}@example.com`, name: "Objects Test User" },
    });
    userId = user.id;

    const workspace = await prisma.workspace.create({
      data: { name: `Objects Test WS ${suffix}`, slug: `objects-test-${suffix}` },
    });
    workspaceId = workspace.id;

    const room = await prisma.room.create({
      data: { workspaceId, name: "Objects Test Room" },
    });
    roomId = room.id;
  });

  afterAll(async () => {
    // Cascades: canvas_objects -> rooms -> (nothing further needed for the
    // room itself); workspace delete cascades rooms per schema.prisma.
    await prisma.workspace.delete({ where: { id: workspaceId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
  });

  function makeObject(overrides: Partial<ObjectState> = {}): ObjectState {
    return {
      objectId: crypto.randomUUID(),
      roomId,
      type: "note",
      x: 10,
      y: 20,
      width: 100,
      height: 80,
      rotation: 0,
      z: 0,
      data: { text: "hello", color: "yellow" },
      version: 1,
      createdById: userId,
      ...overrides,
    };
  }

  it("round-trips a created object through loadRoomObjects", async () => {
    const obj = makeObject();
    await upsertObject(obj);

    const loaded = await loadRoomObjects(roomId);
    const found = loaded.find((o) => o.objectId === obj.objectId);
    expect(found).toEqual(obj);
  });

  it("upsert overwrites an existing row's fields and version", async () => {
    const obj = makeObject({ x: 0, version: 1 });
    await upsertObject(obj);

    const edited: ObjectState = { ...obj, x: 999, version: 2, data: { text: "edited", color: "blue" } };
    await upsertObject(edited);

    const loaded = await loadRoomObjects(roomId);
    const found = loaded.find((o) => o.objectId === obj.objectId);
    expect(found).toEqual(edited);
  });

  it("deleteObject removes the row", async () => {
    const obj = makeObject();
    await upsertObject(obj);
    await deleteObject(obj.objectId);

    const loaded = await loadRoomObjects(roomId);
    expect(loaded.find((o) => o.objectId === obj.objectId)).toBeUndefined();
  });

  it("deleteObject on an already-missing id does not throw", async () => {
    await expect(deleteObject(crypto.randomUUID())).resolves.toBeUndefined();
  });

  it("loadRoomObjects only returns objects for the requested room", async () => {
    const otherRoom = await prisma.room.create({ data: { workspaceId, name: "Other Room" } });
    const objInThisRoom = makeObject();
    const objInOtherRoom = makeObject({ objectId: crypto.randomUUID(), roomId: otherRoom.id });

    await upsertObject(objInThisRoom);
    await upsertObject(objInOtherRoom);

    const loaded = await loadRoomObjects(roomId);
    expect(loaded.some((o) => o.objectId === objInThisRoom.objectId)).toBe(true);
    expect(loaded.some((o) => o.objectId === objInOtherRoom.objectId)).toBe(false);

    await prisma.room.delete({ where: { id: otherRoom.id } });
  });
});
