import { describe, expect, it, vi } from "vitest";

import { createPreviewWhiteboard, createPreviewWhiteboardAdapter, createPreviewWhiteboardProps } from "./preview-whiteboard";

const element = (id: string, version: number, versionNonce = version) => ({
  id,
  type: "rectangle",
  version,
  version_nonce: versionNonce,
  index: `a${version}`,
  is_deleted: false,
  payload: { id, type: "rectangle", version, versionNonce, index: `a${version}`, isDeleted: false } as const,
});

describe("preview whiteboard adapter", () => {
  it("provides deterministic snapshots and broadcasts full and delta updates", async () => {
    const adapter = createPreviewWhiteboardAdapter({ elements: [element("first", 1)] });
    const listener = vi.fn();
    adapter.subscribe(listener);

    await adapter.requestSnapshot();
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ type: "snapshot", revision: "preview-revision-0", elements: [element("first", 1)] }));

    const commit = await adapter.collaboration.submitUpdate({ sceneId: "preview-scene", syncAll: false, elements: [element("second", 1)] });
    expect(commit).toEqual({ operationId: "preview-operation-1", sceneId: "preview-scene", revision: "preview-revision-1", sceneGeneration: "preview-generation-0" });
    expect(adapter.getSnapshot().elements.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ type: "update", elements: [element("second", 1)] }));

    await adapter.collaboration.submitUpdate({ sceneId: "preview-scene", syncAll: true, elements: [element("replacement", 1)] });
    expect(adapter.getSnapshot().elements.map(({ id }) => id)).toEqual(["replacement"]);
  });

  it("ignores stale deltas, clears the scene, and exposes cursor and file calls", async () => {
    const adapter = createPreviewWhiteboardAdapter({ elements: [element("first", 2)] });
    const listener = vi.fn();
    adapter.subscribe(listener);

    await adapter.collaboration.submitUpdate({ sceneId: "preview-scene", syncAll: false, elements: [element("first", 1)] });
    expect(adapter.getSnapshot().elements).toEqual([element("first", 2)]);

    adapter.collaboration.sendCursor({ x: 4, y: 8 });
    expect(adapter.getLastCursor()).toEqual({ x: 4, y: 8 });
    adapter.publishCursor({ participantId: "remote", displayName: "Remote", x: 12, y: 16 });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ type: "cursor", occurredAt: "2030-01-01T00:00:00.000Z" }));

    await adapter.collaboration.fileTransfer?.upload({ fileId: "image-1", mimeType: "image/png", byteLength: 3, sha256: "abc", dataURL: "data:image/png;base64,AA==" });
    await expect(adapter.collaboration.fileTransfer?.download("image-1")).resolves.toEqual({ mimeType: "image/png", dataURL: "data:image/png;base64,AA==" });
    await expect(adapter.collaboration.fileTransfer?.download("missing")).rejects.toThrow("missing");

    const commit = await adapter.collaboration.clear();
    expect(commit.operationId).toBe("preview-operation-2");
    expect(adapter.getSnapshot().elements).toEqual([]);
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ type: "snapshot", elements: [] }));
  });

  it("returns the typed SpaceView whiteboard binding to the real SDK view", () => {
    const adapter = createPreviewWhiteboardAdapter();
    const props = createPreviewWhiteboardProps({ adapter, canDraw: true, theme: "dark" });
    const binding = createPreviewWhiteboard({ adapter, canDraw: true, theme: "dark" });

    expect(props.collab).toBe(adapter.collaboration);
    expect(binding).toEqual({ isOpen: true, props });
  });
});
