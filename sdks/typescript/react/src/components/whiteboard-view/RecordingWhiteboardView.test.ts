import { describe, expect, it } from "vitest";

import { createRecordingWhiteboardCursor, loadRecordingWhiteboardFiles, parseRecordingWhiteboardStateV1, recordingWhiteboardFileAssetId, recordingWhiteboardFileIds, recordingWhiteboardSceneAppState } from "./recording-whiteboard-state";

describe("recording whiteboard state", () => {
  it("replays every change, deletions and seeks without exposing future handwriting", () => {
    const initial = { ...recordingState({}), revision: 1, elements: [wireElement("first", "a0")] };
    const cursor = createRecordingWhiteboardCursor({
      schemaVersion: "recording_whiteboard_history.v1",
      initial,
      updates: [
        { revision: 3, elements: [wireElement("second", "a1")] },
        { revision: 5, elements: [{ ...wireElement("first", "a0"), version: 2, is_deleted: true }] },
      ],
    });
    expect(cursor.at(2).elements.map((element) => element.id)).toEqual(["first"]);
    expect(cursor.at(4).elements.map((element) => element.id)).toEqual(["first", "second"]);
    expect(cursor.at(5).elements[0]?.is_deleted).toBe(true);
    expect(cursor.at(1).elements).toEqual(initial.elements);
    expect(cursor.at(4).revision).toBe(4);
  });

  it("supports stored states and 5000 individual handwriting changes", () => {
    const initial = { ...recordingState({}), revision: 0 };
    expect(createRecordingWhiteboardCursor(initial).at(0)).toEqual(initial);
    const cursor = createRecordingWhiteboardCursor({ schemaVersion: "recording_whiteboard_history.v1", initial, updates: Array.from({ length: 5000 }, (_, index) => ({ revision: index + 1, elements: [wireElement(`stroke-${index}`, `a${String(index).padStart(6, "0")}`)] })) });
    expect(cursor.at(400).elements).toHaveLength(400);
    expect(cursor.at(1629).elements).toHaveLength(1629);
    expect(cursor.at(5000).elements).toHaveLength(5000);
  });

  it("rejects malformed histories before drawing", () => {
    const initial = { ...recordingState({}), revision: 1 };
    for (const updates of [[{ revision: 1, elements: [wireElement("first", "a0")] }], [{ revision: 2, elements: [] }], [{ revision: 2, elements: [{}] }]]) {
      expect(() => createRecordingWhiteboardCursor({ schemaVersion: "recording_whiteboard_history.v1", initial, updates })).toThrow("recording whiteboard state is invalid");
    }
  });
  it("validates canonical ordering and exposes required file asset ids", async () => {
    const state = parseRecordingWhiteboardStateV1({
      schemaVersion: "recording_whiteboard_state.v1",
      sceneId: "scene-1",
      revision: 7,
      appState: { view_background_color: "#ffffff" },
      elements: [wireElement("a", "a0"), wireElement("b", "a1", "file-1")],
    });

    expect(state.appState).toEqual({ view_background_color: "#ffffff" });
    expect(parseRecordingWhiteboardStateV1(state)).toEqual(state);
    expect(parseRecordingWhiteboardStateV1({ ...state, appState: {}, elements: [] }).appState).toEqual({});
    expect(recordingWhiteboardFileIds(state)).toEqual(["file-1"]);
    expect(recordingWhiteboardFileAssetId("file-1")).toBe("whiteboard_file:file-1");
    await expect(
      loadRecordingWhiteboardFiles(state, async ({ assetId }) => ({
        mimeType: "image/png",
        dataURL: "data:image/png;base64,AAAA",
        createdAtMs: assetId === "whiteboard_file:file-1" ? 0 : 1,
      })),
    ).resolves.toMatchObject({ "file-1": { id: "file-1", mimeType: "image/png", dataURL: "data:image/png;base64,AAAA", created: 0 } });
    expect(() => parseRecordingWhiteboardStateV1({ ...state, appState: { view_background_color: "#ffffff" }, elements: [...state.elements].reverse() })).toThrow("canonical order");
  });

  it.each([{ viewBackgroundColor: "#ffffff" }, { view_background_color: "#ffffff", theme: "light" }, { theme: "dark" }])("rejects unsupported shared app state: %j", (appState) => {
    expect(() =>
      parseRecordingWhiteboardStateV1({
        schemaVersion: "recording_whiteboard_state.v1",
        sceneId: "scene-1",
        revision: 7,
        appState,
        elements: [],
      }),
    ).toThrow("recording whiteboard state is invalid");
  });

  it("resets a cleared scene to the initialized canvas background", () => {
    const colored = parseRecordingWhiteboardStateV1(recordingState({ view_background_color: "#aabbcc" }));
    const cleared = parseRecordingWhiteboardStateV1(recordingState({}));

    expect([recordingWhiteboardSceneAppState(colored, "initialized-default"), recordingWhiteboardSceneAppState(cleared, "initialized-default")]).toEqual([{ viewBackgroundColor: "#aabbcc" }, { viewBackgroundColor: "initialized-default" }]);
  });
});

function recordingState(appState: object) {
  return { schemaVersion: "recording_whiteboard_state.v1", sceneId: "scene-1", revision: 7, appState, elements: [] };
}

function wireElement(id: string, index: string, fileId?: string) {
  return { id, type: "rectangle", version: 1, version_nonce: 2, index, is_deleted: false, payload: fileId === undefined ? {} : { fileId } };
}
