import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// The routes are thin: they find out who is signed in, read and check the request, and hand over to the
// database functions, which apply the who-may-do-what rules (packages/db/src/roomLayouts.ts). What these
// tests protect: the actor is always the signed-in person, never anyone named in the request, and every
// database answer becomes the right HTTP status.

const db = vi.hoisted(() => ({
  saveLayoutVersion: vi.fn(),
  publishLayoutVersion: vi.fn(),
  restoreLayoutVersion: vi.fn(),
  listLayoutVersions: vi.fn(),
  getLayoutVersion: vi.fn(),
  changeMemberRole: vi.fn(),
}));
vi.mock("@workspace-video/db", () => db);
const session = vi.hoisted(() => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/session", () => session);

import { GET as listVersions, POST as saveVersion } from "../rooms/[roomId]/layout/versions/route";
import { GET as getVersion } from "../rooms/[roomId]/layout/versions/[version]/route";
import { POST as publish } from "../rooms/[roomId]/layout/publish/route";
import { POST as restore } from "../rooms/[roomId]/layout/restore/route";
import { PATCH as changeRole } from "../workspaces/[workspaceId]/members/[userId]/route";

const ME = { userId: "user-me", email: "me@example.com" };
const roomParams = { params: Promise.resolve({ roomId: "room-1" }) };

function post(body: unknown, method = "POST") {
  return new NextRequest("http://localhost/api/x", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}
const get = () => new NextRequest("http://localhost/api/x");

beforeEach(() => {
  for (const fn of Object.values(db)) fn.mockReset();
  session.getSessionUser.mockReset();
  session.getSessionUser.mockResolvedValue(ME);
});

describe("nobody signed in", () => {
  it("gets 401 from every route, and no database function is called", async () => {
    session.getSessionUser.mockResolvedValue(null);
    const responses = await Promise.all([
      listVersions(get(), roomParams),
      saveVersion(post({ map: {}, baseVersion: 0 }), roomParams),
      getVersion(get(), { params: Promise.resolve({ roomId: "room-1", version: "1" }) }),
      publish(post({ version: 1, expectedLiveVersion: null }), roomParams),
      restore(post({ version: 1 }), roomParams),
      changeRole(post({ role: "designer" }, "PATCH"), { params: Promise.resolve({ workspaceId: "ws", userId: "u2" }) }),
    ]);
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401]);
    for (const fn of Object.values(db)) expect(fn).not.toHaveBeenCalled();
  });
});

describe("saving", () => {
  it("acts as the signed-in person, and ignores anyone the request claims to be", async () => {
    db.saveLayoutVersion.mockResolvedValue({ ok: true, version: 3 });
    const res = await saveVersion(post({ map: { version: 1, zones: [] }, baseVersion: 2, note: "n", actorUserId: "someone-else", userId: "someone-else" }), roomParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 3 });
    expect(db.saveLayoutVersion).toHaveBeenCalledWith({ roomId: "room-1", actorUserId: "user-me", map: { version: 1, zones: [] }, baseVersion: 2, note: "n" });
  });

  it("turns each answer of the database into the right status, with the details a screen needs", async () => {
    const cases: [object, number][] = [
      [{ ok: false, reason: "forbidden", message: "Only an owner, an admin or a designer can do that." }, 403],
      [{ ok: false, reason: "not_found", message: "That room was not found." }, 404],
      [{ ok: false, reason: "invalid", message: "The map did not pass its checks.", errors: ["A map needs at least one area"] }, 400],
      [{ ok: false, reason: "conflict", message: "Someone saved a newer version first.", latestVersion: 5 }, 409],
    ];
    for (const [answer, status] of cases) {
      db.saveLayoutVersion.mockResolvedValueOnce(answer);
      const res = await saveVersion(post({ map: {}, baseVersion: 0 }), roomParams);
      expect(res.status).toBe(status);
      expect(await res.json()).toMatchObject({ error: (answer as { message: string }).message });
    }
    db.saveLayoutVersion.mockResolvedValueOnce(cases[3]![0]);
    expect(await (await saveVersion(post({ map: {}, baseVersion: 0 }), roomParams)).json()).toMatchObject({ reason: "conflict", latestVersion: 5 });
    db.saveLayoutVersion.mockResolvedValueOnce(cases[2]![0]);
    expect(await (await saveVersion(post({ map: {}, baseVersion: 0 }), roomParams)).json()).toMatchObject({ errors: ["A map needs at least one area"] });
  });

  it("refuses a request that is not JSON, or has no usable starting version, without calling the database", async () => {
    for (const body of ["not json", {}, { map: {} }, { map: {}, baseVersion: "2" }, { map: {}, baseVersion: 1.5 }, { map: {}, baseVersion: -1 }]) {
      const res = await saveVersion(post(body), roomParams);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(db.saveLayoutVersion).not.toHaveBeenCalled();
  });
});

describe("publishing and restoring", () => {
  it("publishes as the signed-in person, with the live version the editor saw", async () => {
    db.publishLayoutVersion.mockResolvedValue({ ok: true, version: 2 });
    const res = await publish(post({ version: 2, expectedLiveVersion: 1, actorUserId: "x" }), roomParams);
    expect(res.status).toBe(200);
    expect(db.publishLayoutVersion).toHaveBeenCalledWith({ roomId: "room-1", actorUserId: "user-me", version: 2, expectedLiveVersion: 1 });
    await publish(post({ version: 2, expectedLiveVersion: null }), roomParams);
    expect(db.publishLayoutVersion).toHaveBeenLastCalledWith({ roomId: "room-1", actorUserId: "user-me", version: 2, expectedLiveVersion: null });
  });

  it("says 409 with the live version when someone published first, and refuses unusable requests", async () => {
    db.publishLayoutVersion.mockResolvedValue({ ok: false, reason: "conflict", message: "Someone published a different version first.", liveVersion: 4 });
    const res = await publish(post({ version: 2, expectedLiveVersion: null }), roomParams);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ liveVersion: 4 });
    db.publishLayoutVersion.mockClear();
    for (const body of ["nope", {}, { version: "2", expectedLiveVersion: null }, { version: 2 }, { version: 2, expectedLiveVersion: "1" }, { version: 0, expectedLiveVersion: null }]) {
      expect((await publish(post(body), roomParams)).status, JSON.stringify(body)).toBe(400);
    }
    expect(db.publishLayoutVersion).not.toHaveBeenCalled();
  });

  it("restores as the signed-in person and refuses a missing or unusable version", async () => {
    db.restoreLayoutVersion.mockResolvedValue({ ok: true, version: 6 });
    const res = await restore(post({ version: 1, actorUserId: "x" }), roomParams);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: 6 });
    expect(db.restoreLayoutVersion).toHaveBeenCalledWith({ roomId: "room-1", actorUserId: "user-me", version: 1 });
    for (const body of ["nope", {}, { version: "1" }, { version: 1.2 }, { version: 0 }]) {
      expect((await restore(post(body), roomParams)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("reading the history", () => {
  it("lists as the signed-in person, and returns 403 to someone who may not see it", async () => {
    db.listLayoutVersions.mockResolvedValueOnce({ ok: true, liveVersion: 1, versions: [] });
    const ok = await listVersions(get(), roomParams);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ ok: true, liveVersion: 1, versions: [] });
    expect(db.listLayoutVersions).toHaveBeenCalledWith({ roomId: "room-1", actorUserId: "user-me" });
    db.listLayoutVersions.mockResolvedValueOnce({ ok: false, reason: "forbidden", message: "Only an owner, an admin or a designer can do that." });
    expect((await listVersions(get(), roomParams)).status).toBe(403);
  });

  it("opens one version by number, and refuses a number that is not a whole positive number", async () => {
    db.getLayoutVersion.mockResolvedValue({ ok: true, version: 2, map: { version: 1, zones: [] }, createdById: "u", createdAt: new Date(0), note: null });
    const res = await getVersion(get(), { params: Promise.resolve({ roomId: "room-1", version: "2" }) });
    expect(res.status).toBe(200);
    expect(db.getLayoutVersion).toHaveBeenCalledWith({ roomId: "room-1", actorUserId: "user-me", version: 2 });
    for (const version of ["x", "1.5", "0", "-1", ""]) {
      expect((await getVersion(get(), { params: Promise.resolve({ roomId: "room-1", version }) })).status, version).toBe(400);
    }
  });
});

describe("changing a role", () => {
  const params = { params: Promise.resolve({ workspaceId: "ws-1", userId: "u-target" }) };

  it("acts as the signed-in person on the person named in the address, with the role from the body", async () => {
    db.changeMemberRole.mockResolvedValue({ ok: true, role: "designer" });
    const res = await changeRole(post({ role: "designer", actorUserId: "someone-else" }, "PATCH"), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, role: "designer" });
    expect(db.changeMemberRole).toHaveBeenCalledWith({ workspaceId: "ws-1", actorUserId: "user-me", targetUserId: "u-target", newRole: "designer" });
  });

  it("turns each refusal into a status, and refuses a role that does not exist without asking the database", async () => {
    const cases: [string, number][] = [["forbidden", 403], ["not_found", 404], ["invalid", 400], ["last_owner", 409]];
    for (const [reason, status] of cases) {
      db.changeMemberRole.mockResolvedValueOnce({ ok: false, reason, message: `refused: ${reason}` });
      const res = await changeRole(post({ role: "member" }, "PATCH"), params);
      expect(res.status, reason).toBe(status);
      expect(await res.json()).toMatchObject({ error: `refused: ${reason}`, reason });
    }
    db.changeMemberRole.mockClear();
    for (const body of ["nope", {}, { role: "superuser" }, { role: 5 }, { role: "" }]) {
      expect((await changeRole(post(body, "PATCH"), params)).status, JSON.stringify(body)).toBe(400);
    }
    expect(db.changeMemberRole).not.toHaveBeenCalled();
  });
});
