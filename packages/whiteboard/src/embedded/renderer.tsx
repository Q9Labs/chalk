import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type { WhiteboardCollaborationEvent } from "../collab/engine";
import { WhiteboardCanvas } from "../react/WhiteboardCanvas";
import type { ChalkEmbeddedWhiteboardHostEnvelope } from "./protocol";
import { ChalkEmbeddedWhiteboardRendererBridge } from "./renderer-bridge";
import { applyEmbeddedWhiteboardViewport } from "./renderer-viewport";

declare global {
  interface Window {
    EXCALIDRAW_ASSET_PATH?: string;
  }
}

window.EXCALIDRAW_ASSET_PATH = "./";

const rendererRoot = requireRendererRoot();
const bridge = new ChalkEmbeddedWhiteboardRendererBridge();

type Configuration = {
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly theme: "light" | "dark";
  readonly localParticipantColor?: string;
};

function EmbeddedWhiteboardRenderer(): React.JSX.Element {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [closed, setClosed] = useState(false);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const viewportRef = useRef<Extract<ChalkEmbeddedWhiteboardHostEnvelope, { readonly type: "set_viewport" }>["payload"] | null>(null);
  const collaboration = useMemo(() => createCollaborationBridge(bridge), []);

  useEffect(() => {
    const unsubscribe = bridge.subscribe((message) => {
      switch (message.type) {
        case "initialize":
          setConfiguration(requireConfiguration(message.payload));
          return;
        case "set_capabilities":
          setConfiguration((current) => (current ? { ...current, ...requireCapabilities(message.payload) } : current));
          return;
        case "set_viewport":
          viewportRef.current = requireViewport(message.payload);
          applyCurrentViewport(apiRef.current, viewportRef.current);
          return;
        case "prepare_close": {
          const reason = requireReason(message.payload);
          setClosed(true);
          bridge.post({ type: "close_ready", payload: { reason } });
          return;
        }
        case "request_user_export":
          void exportScene(message, apiRef.current);
      }
    });
    bridge.start();
    return unsubscribe;
  }, []);

  if (closed) return <div className="chalk-whiteboard-closed">Whiteboard closed</div>;
  if (!configuration) return <div className="chalk-whiteboard-loading">Loading whiteboard…</div>;

  return (
    <WhiteboardCanvas
      canDraw={configuration.canDraw}
      collab={{ ...collaboration, canDraw: configuration.canDraw }}
      excalidrawCssPath="./index.css"
      isVisible={true}
      localParticipantColor={configuration.localParticipantColor}
      onExcalidrawApiReady={(api) => {
        apiRef.current = api;
        applyCurrentViewport(api, viewportRef.current);
      }}
      onLoadError={(error) => {
        bridge.post({ type: "error", payload: { code: "renderer_load_failed", message: error.message.slice(0, 256), recoverable: false } });
      }}
      theme={configuration.theme}
    />
  );
}

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
    fileTransfer: {
      upload: (input: Parameters<ChalkEmbeddedWhiteboardRendererBridge["uploadFile"]>[0]) => rendererBridge.uploadFile(input),
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

async function exportScene(message: ChalkEmbeddedWhiteboardHostEnvelope, api: ExcalidrawImperativeAPI | null): Promise<void> {
  const request = message.payload as { readonly requestId?: unknown; readonly format?: unknown };
  if (!api || typeof request.requestId !== "string" || (request.format !== "png" && request.format !== "svg")) {
    bridge.post({ type: "error", payload: { code: "export_failed", message: "Whiteboard export request is invalid", recoverable: true } });
    return;
  }

  try {
    if (request.format === "png") {
      const blob = await exportToBlob({
        elements: api.getSceneElements(),
        appState: api.getAppState(),
        files: api.getFiles(),
        mimeType: "image/png",
      });
      bridge.post({
        type: "user_export",
        payload: {
          requestId: request.requestId,
          format: "png",
          mimeType: "image/png",
          dataURL: await blobToDataURL(blob),
        },
      });
      return;
    }

    const svg = await exportToSvg({
      elements: api.getSceneElements(),
      appState: api.getAppState(),
      files: api.getFiles(),
    });
    const dataURL = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(new XMLSerializer().serializeToString(svg))))}`;
    bridge.post({
      type: "user_export",
      payload: { requestId: request.requestId, format: "svg", mimeType: "image/svg+xml", dataURL },
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error("Whiteboard export failed");
    bridge.post({ type: "error", payload: { code: "export_failed", message: error.message.slice(0, 256), recoverable: true } });
  }
}

function requireConfiguration(value: unknown): Configuration {
  if (!isRecord(value) || typeof value.canDraw !== "boolean" || typeof value.canClear !== "boolean" || (value.theme !== "light" && value.theme !== "dark")) {
    throw new Error("embedded whiteboard initialization is invalid");
  }
  if (value.localParticipantColor !== undefined && typeof value.localParticipantColor !== "string") throw new Error("embedded whiteboard participant color is invalid");
  return {
    canDraw: value.canDraw,
    canClear: value.canClear,
    theme: value.theme,
    ...(typeof value.localParticipantColor === "string" ? { localParticipantColor: value.localParticipantColor } : {}),
  };
}

function requireCapabilities(value: unknown): Pick<Configuration, "canDraw" | "canClear"> {
  if (!isRecord(value) || typeof value.canDraw !== "boolean" || typeof value.canClear !== "boolean") throw new Error("embedded whiteboard capabilities are invalid");
  return { canDraw: value.canDraw, canClear: value.canClear };
}

function requireViewport(value: unknown): Extract<ChalkEmbeddedWhiteboardHostEnvelope, { readonly type: "set_viewport" }>["payload"] {
  if (
    typeof value !== "object" ||
    value === null ||
    !("width" in value) ||
    !("height" in value) ||
    !("scale" in value) ||
    typeof value.width !== "number" ||
    typeof value.height !== "number" ||
    typeof value.scale !== "number" ||
    !Number.isFinite(value.width) ||
    value.width <= 0 ||
    !Number.isFinite(value.height) ||
    value.height <= 0 ||
    !Number.isFinite(value.scale) ||
    value.scale <= 0
  ) {
    throw new Error("embedded whiteboard viewport is invalid");
  }
  return { width: value.width, height: value.height, scale: value.scale };
}

function applyCurrentViewport(api: ExcalidrawImperativeAPI | null, viewport: Extract<ChalkEmbeddedWhiteboardHostEnvelope, { readonly type: "set_viewport" }>["payload"] | null): void {
  if (!api || !viewport) return;
  applyEmbeddedWhiteboardViewport(api, rendererRoot, viewport);
}

function requireReason(value: unknown): string {
  if (!isRecord(value) || typeof value.reason !== "string" || value.reason.length === 0) throw new Error("embedded whiteboard close reason is invalid");
  return value.reason;
}

function requireRendererRoot(): HTMLElement {
  const root = document.getElementById("root");
  if (!root) throw new Error("embedded whiteboard root is missing");
  return root;
}

function blobToDataURL(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Whiteboard export could not be encoded"));
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

createRoot(rendererRoot).render(
  <StrictMode>
    <EmbeddedWhiteboardRenderer />
  </StrictMode>,
);
