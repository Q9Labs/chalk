/* @vitest-environment jsdom */
import type { ChalkWhiteboardSummary, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { useWhiteboardSceneSubscription } from "./useWhiteboardSceneSubscription";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

it.each(["before", "after"])("keeps the canvas mounted when readiness arrives %s startup completion", async (readiness) => {
  let observe: ((summary: ChalkWhiteboardSummary) => void) | undefined;
  const summary: ChalkWhiteboardSummary = { status: "ready", sceneId: "scene", revision: "1", capabilities: ["drawWhiteboard"], canDraw: true, canClear: false, presenting: true, error: null };
  const commit = async () => ({ operationId: "op", sceneId: "scene", revision: "1" });
  const transport: ChalkWhiteboardV1Transport = {
    startSceneSubscription: async () => {
      if (readiness === "before") observe?.(summary);
    },
    stopSceneSubscription: vi.fn(),
    subscribeSummary: (listener) => {
      observe = listener;
      return () => undefined;
    },
    subscribe: () => () => undefined,
    submitUpdate: commit,
    sendCursor: () => undefined,
    requestSnapshot: async () => undefined,
    clear: commit,
    setDrawPermission: async () => undefined,
    files: {
      initiateUpload: async () => ({ uploadId: "upload", method: "PUT", uploadUrl: "https://files.test", headers: {}, expiresAt: "2030-01-01T00:00:00Z" }),
      finalizeUpload: async () => undefined,
      getDownloadUrl: async () => ({ downloadUrl: "https://files.test", expiresAt: "2030-01-01T00:00:00Z" }),
    },
  };
  let current: ReturnType<typeof useWhiteboardSceneSubscription> = { status: "closed" };
  const Harness = () => {
    current = useWhiteboardSceneSubscription(transport, true);
    return null;
  };
  const root = createRoot(document.createElement("div"));
  await act(async () => {
    root.render(createElement(Harness));
  });
  expect(current.status).toBe("ready");
  if (readiness === "after") act(() => observe?.(summary));
  act(() => observe?.({ ...summary, status: "recovering" }));
  expect(current).toEqual({ status: "ready", transport });
  expect(transport.stopSceneSubscription).not.toHaveBeenCalled();
  act(() => observe?.({ ...summary, status: "loading" }));
  expect(current.status).toBe("ready");
  act(() => root.unmount());
  expect(transport.stopSceneSubscription).toHaveBeenCalledOnce();
});
