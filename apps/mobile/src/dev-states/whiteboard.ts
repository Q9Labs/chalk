import type { ChalkWhiteboardV1Event, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";

export function boardTransport(present: (presenting: boolean) => void): ChalkWhiteboardV1Transport {
  const listeners = new Set<(event: ChalkWhiteboardV1Event) => void>();
  let revision = 1;
  const snapshot = (): ChalkWhiteboardV1Event => ({ type: "snapshot", sceneId: "scene-1", revision: String(revision), elements: [] });
  const commit = () => ({ operationId: `op-${++revision}`, sceneId: "scene-1", revision: String(revision) });
  return {
    startSceneSubscription: () => Promise.resolve(),
    stopSceneSubscription: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      queueMicrotask(() => listener(snapshot()));
      return () => void listeners.delete(listener);
    },
    submitUpdate: async () => commit(),
    sendCursor: () => undefined,
    requestSnapshot: async () => {
      for (const listener of listeners) listener(snapshot());
    },
    clear: async () => commit(),
    setDrawPermission: async () => undefined,
    setPresentation: async (presenting) => present(presenting),
    files: {
      initiateUpload: async () => ({ uploadId: "u1", method: "PUT", uploadUrl: "about:blank", headers: {}, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      finalizeUpload: async () => undefined,
      getDownloadUrl: async () => ({ downloadUrl: "about:blank", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    },
  };
}
