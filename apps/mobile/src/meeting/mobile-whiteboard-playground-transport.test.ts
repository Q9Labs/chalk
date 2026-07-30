import type { ChalkEmbeddedWhiteboardProps } from "@q9labsai/chalk-react-native";
import { describe, expect, it } from "vitest";
import { createMobileWhiteboardPlaygroundTransport } from "./mobile-whiteboard-playground-transport";

type PlaygroundEvent = Parameters<Parameters<ChalkEmbeddedWhiteboardProps["transport"]["subscribe"]>[0]>[0];
type PlaygroundElement = Parameters<ChalkEmbeddedWhiteboardProps["transport"]["submitUpdate"]>[0]["elements"][number];

describe("mobile whiteboard playground transport", () => {
  it("merges deltas, full syncs, and tombstones, then starts a new scene on clear", async () => {
    const transport = createMobileWhiteboardPlaygroundTransport();
    const events: PlaygroundEvent[] = [];
    transport.subscribe((event) => events.push(event));
    await transport.startSceneSubscription();

    await transport.submitUpdate({ sceneId: "local-renderer-playground-0", syncAll: false, elements: [element("a")] });
    await transport.submitUpdate({ sceneId: "local-renderer-playground-0", syncAll: false, elements: [element("b")] });
    await transport.requestSnapshot();
    expect(latestSnapshot(events).elements.map((value) => value.id)).toEqual(["a", "b"]);

    await transport.submitUpdate({
      sceneId: "local-renderer-playground-0",
      syncAll: true,
      elements: [element("b", true), element("c")],
    });
    await transport.requestSnapshot();
    const fullSyncElements = latestSnapshot(events).elements;
    expect(fullSyncElements.map((value) => value.id)).toEqual(["a", "b", "c"]);
    expect(fullSyncElements.find((value) => value.id === "b")?.isDeleted).toBe(true);

    const beforeClearSceneId = latestSnapshot(events).sceneId;
    const commit = await transport.clear();
    const cleared = latestSnapshot(events);
    expect(cleared.sceneId).not.toBe(beforeClearSceneId);
    expect(commit.sceneId).toBe(cleared.sceneId);
    expect(cleared.elements).toEqual([]);
  });
});

function element(id: string, isDeleted = false): PlaygroundElement {
  return {
    id,
    type: "rectangle",
    version: 1,
    versionNonce: 1,
    index: `a${id}`,
    isDeleted,
    payload: {},
  };
}

function latestSnapshot(events: PlaygroundEvent[]): Extract<PlaygroundEvent, { type: "snapshot" }> {
  const snapshot = events.findLast((event): event is Extract<PlaygroundEvent, { type: "snapshot" }> => event.type === "snapshot");
  if (!snapshot) throw new Error("Expected a playground snapshot");
  return snapshot;
}
