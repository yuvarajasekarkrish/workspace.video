import { describe, it, expect, vi, beforeEach } from "vitest";
import { ObjectInteractionController } from "../ObjectInteractionController";
import { objectsStore } from "@/store/objectsStore";
import type { ObjectState } from "@workspace-video/shared";

function makeObject(overrides: Partial<ObjectState> = {}): ObjectState {
  return {
    objectId: "obj1",
    roomId: "room1",
    type: "note",
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    rotation: 0,
    z: 0,
    data: {},
    version: 1,
    createdById: "u1",
    ...overrides,
  };
}

function makeController(scale = 1) {
  const onSendUpsert = vi.fn();
  const onSendDelete = vi.fn();
  const controller = new ObjectInteractionController("u1", "room1", {
    onSendUpsert,
    onSendDelete,
    getScale: () => scale,
  });
  return { controller, onSendUpsert, onSendDelete };
}

describe("ObjectInteractionController", () => {
  beforeEach(() => objectsStore.getState().clear());

  it("handleGestureStart on empty canvas returns false (falls through to pan/click-to-walk)", () => {
    const { controller } = makeController();
    expect(controller.handleGestureStart({ x: 500, y: 500 })).toBe(false);
  });

  it("handleGestureStart on an object claims the gesture and selects it", () => {
    objectsStore.getState().applySnapshot([makeObject()]);
    const { controller } = makeController();

    expect(controller.handleGestureStart({ x: 10, y: 10 })).toBe(true);
    expect(objectsStore.getState().selectedId).toBe("obj1");
  });

  it("handleGestureStart on empty canvas while something is selected deselects", () => {
    objectsStore.getState().applySnapshot([makeObject()]);
    objectsStore.getState().setSelected("obj1");
    const { controller } = makeController();

    expect(controller.handleGestureStart({ x: 9999, y: 9999 })).toBe(false);
    expect(objectsStore.getState().selectedId).toBeNull();
  });

  it("dragging moves the object's render position immediately and emits an upsert", () => {
    objectsStore.getState().applySnapshot([makeObject({ x: 0, y: 0 })]);
    const { controller, onSendUpsert } = makeController();

    controller.handleGestureStart({ x: 10, y: 10 });
    controller.handleGestureMove({ x: 30, y: 25 }); // +20,+15 delta

    const record = objectsStore.getState().objects.get("obj1")!;
    expect(record.render).toEqual({ x: 20, y: 15, width: 100, height: 100 });
    expect(onSendUpsert).toHaveBeenCalledTimes(1);
    expect(onSendUpsert.mock.calls[0]![0]).toMatchObject({ x: 20, y: 15, baseVersion: 1 });
  });

  it("throttles rapid drag emits, then flushes the final position on gesture end", () => {
    objectsStore.getState().applySnapshot([makeObject({ x: 0, y: 0 })]);
    const { controller, onSendUpsert } = makeController();

    controller.handleGestureStart({ x: 0, y: 0 });
    controller.handleGestureMove({ x: 1, y: 0 }); // first move: sent immediately
    controller.handleGestureMove({ x: 2, y: 0 }); // same tick, well within 50ms — suppressed
    controller.handleGestureMove({ x: 3, y: 0 }); // still suppressed

    expect(onSendUpsert).toHaveBeenCalledTimes(1);

    controller.handleGestureEnd(); // final send bypasses the throttle unconditionally

    expect(onSendUpsert).toHaveBeenCalledTimes(2);
    expect(onSendUpsert.mock.calls[1]![0]).toMatchObject({ x: 3, y: 0 });
  });

  it("resizing from the se handle grows width/height without moving x/y", () => {
    objectsStore.getState().applySnapshot([makeObject({ x: 100, y: 100, width: 200, height: 100 })]);
    const { controller } = makeController();

    controller.handleGestureStart({ x: 100, y: 100 }); // select
    controller.handleGestureEnd();
    controller.handleGestureStart({ x: 300, y: 200 }); // grab the se handle at the bottom-right corner
    controller.handleGestureMove({ x: 350, y: 220 });

    const record = objectsStore.getState().objects.get("obj1")!;
    expect(record.render).toEqual({ x: 100, y: 100, width: 250, height: 120 });
  });

  it("deleteSelected sends a delete for the selected object and does nothing without a selection", () => {
    objectsStore.getState().applySnapshot([makeObject({ version: 3 })]);
    const { controller, onSendDelete } = makeController();

    controller.deleteSelected(); // nothing selected yet
    expect(onSendDelete).not.toHaveBeenCalled();

    objectsStore.getState().setSelected("obj1");
    controller.deleteSelected();
    expect(onSendDelete).toHaveBeenCalledWith({ objectId: "obj1", roomId: "room1", baseVersion: 3 });
  });

  it("createObject adds an optimistic object (version 0, baseVersion 0) and selects it", () => {
    const { controller, onSendUpsert } = makeController();

    controller.createObject("note", { x: 50, y: 60 }, { text: "hi" });

    const objects = Array.from(objectsStore.getState().objects.values());
    expect(objects).toHaveLength(1);
    expect(objects[0]!.state.version).toBe(0);
    expect(objects[0]!.state.createdById).toBe("u1");
    expect(objectsStore.getState().selectedId).toBe(objects[0]!.state.objectId);
    expect(onSendUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ type: "note", x: 50, y: 60, baseVersion: 0, data: { text: "hi" } }),
    );
  });

  it("createObject places the new object above every existing one in z-order", () => {
    objectsStore.getState().applySnapshot([makeObject({ objectId: "existing", z: 7 })]);
    const { controller } = makeController();

    controller.createObject("shape", { x: 0, y: 0 }, {});

    const created = Array.from(objectsStore.getState().objects.values()).find((r) => r.state.objectId !== "existing");
    expect(created!.state.z).toBe(8);
  });

  it("deselect clears the current selection", () => {
    objectsStore.getState().applySnapshot([makeObject()]);
    objectsStore.getState().setSelected("obj1");
    const { controller } = makeController();

    controller.deselect();
    expect(objectsStore.getState().selectedId).toBeNull();
  });
});
