import type { WhiteboardCollaborationEvent } from "../collab/engine";
import type { ChalkEmbeddedWhiteboardHostEnvelope } from "./protocol";
import type { ChalkEmbeddedWhiteboardRendererBridge } from "./renderer-bridge";

export function createCollaborationBridge(rendererBridge: ChalkEmbeddedWhiteboardRendererBridge) {
  const listeners = new Set<(event: WhiteboardCollaborationEvent) => void>();
  rendererBridge.subscribe((message) => {
    const event = collaborationEvent(message);
    if (event) listeners.forEach((listener) => listener(event));
  });

  return {
    submitUpdate: (payload: Parameters<ChalkEmbeddedWhiteboardRendererBridge["submitUpdate"]>[0]) => rendererBridge.submitUpdate(payload),
    sendCursor: ({ x, y }: { readonly x: number; readonly y: number }) => rendererBridge.post({ type: "cursor", payload: { x, y } }),
    requestSnapshot: () => rendererBridge.requestSnapshot(),
    clear: () => rendererBridge.clear(),
    uploadFile: rendererBridge.uploadFile.bind(rendererBridge),
    fileTransfer: {
      download: (fileId: string) => rendererBridge.downloadFile(fileId),
    },
    subscribe: (listener: (event: WhiteboardCollaborationEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSubmissionError: (cause: unknown) => {
      const message = cause instanceof Error ? cause.message : "Whiteboard submission failed";
      rendererBridge.post({ type: "error", payload: { code: "submission_failed", message: message.slice(0, 256), recoverable: true } });
    },
  };
}

function collaborationEvent(message: ChalkEmbeddedWhiteboardHostEnvelope): WhiteboardCollaborationEvent | null {
  switch (message.type) {
    case "apply_snapshot": {
      const payload = message.payload as Extract<ChalkEmbeddedWhiteboardHostEnvelope, { readonly type: "apply_snapshot" }>["payload"];
      return { type: "snapshot", ...payload };
    }
    case "apply_update": {
      const payload = message.payload as Extract<ChalkEmbeddedWhiteboardHostEnvelope, { readonly type: "apply_update" }>["payload"];
      return { type: "update", ...payload };
    }
    case "apply_view":
      return { type: "view", ...message.payload };
    case "apply_cursor": {
      const payload = message.payload as Extract<ChalkEmbeddedWhiteboardHostEnvelope, { readonly type: "apply_cursor" }>["payload"];
      return { type: "cursor", ...payload };
    }
    case "reset_required": {
      const payload = message.payload as Extract<ChalkEmbeddedWhiteboardHostEnvelope, { readonly type: "reset_required" }>["payload"];
      return { type: "reset_required", ...payload };
    }
    default:
      return null;
  }
}
