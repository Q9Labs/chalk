import { describe, expect, it, vi } from "vitest";
import { initialConnectionSnapshot } from "../connection/snapshot";
import { SpaceStore } from "./store";

describe("SpaceStore", () => {
  it("preserves every untouched slice by reference", () => {
    const store = new SpaceStore();
    const initial = initialConnectionSnapshot();
    store.updateConnection(initial);
    const before = store.getSnapshot();

    const connectionUpdate = { ...initial, state: "joining" };
    store.updateConnection(connectionUpdate);
    const joining = store.getSnapshot();

    expect(joining.connection).not.toBe(before.connection);
    expect(joining.self).toBe(before.self);
    expect(joining.participants).toBe(before.participants);
    expect(joining.media).toBe(before.media);
    expect(joining.chat).toBe(before.chat);
    expect(joining.reactions).toBe(before.reactions);
    expect(joining.whiteboard).toBe(before.whiteboard);

    store.updateChat(Object.freeze({ ...joining.chat, status: "loading" }));
    const loading = store.getSnapshot();

    expect(loading.connection).toBe(joining.connection);
    expect(loading.self).toBe(joining.self);
    expect(loading.participants).toBe(joining.participants);
    expect(loading.media).toBe(joining.media);
    expect(loading.chat).not.toBe(joining.chat);
    expect(loading.reactions).toBe(joining.reactions);
    expect(loading.whiteboard).toBe(joining.whiteboard);
  });

  it("publishes only when projected state changes", () => {
    const store = new SpaceStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const snapshot = initialConnectionSnapshot();

    store.updateConnection(snapshot);
    store.updateConnection(snapshot);
    expect(listener).not.toHaveBeenCalled();

    store.select("camera", "camera-1");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot().media.selection.camera).toBe("camera-1");
  });
});
