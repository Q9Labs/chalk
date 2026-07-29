import { describe, expect, it } from "vitest";
import { InMemoryChalkWhiteboardV1PendingOperationStore } from "./v1-persistence";

const sceneId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c21";
const operationId = "018f2f65-2a77-7a44-8e9a-5b0b6f8d4c22";

describe("whiteboard-v1 pending operation persistence", () => {
  it("copies values at the persistence boundary and removes committed receipts", async () => {
    const store = new InMemoryChalkWhiteboardV1PendingOperationStore();
    await store.put({
      operationId,
      frame: { type: "clear", operation_id: operationId, scene_id: sceneId },
      createdAt: 1,
      bytes: 96,
    });

    const first = await store.load();
    expect(first).toHaveLength(1);
    await store.remove(operationId);
    expect(await store.load()).toEqual([]);
  });
});
