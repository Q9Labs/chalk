import { Facehash } from "@q9labsai/facehash/react";
import { exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";

import type { WhiteboardCollaborationEvent } from "../collab/engine";
import { BoardToastContext, type BoardToast } from "../react/board/board-toasts";
import { Board } from "../react/board/Board";
import { WhiteboardCanvas, type WhiteboardCanvasProps } from "../react/WhiteboardCanvas";
import type { ChalkEmbeddedBoardContext } from "./protocol";
import type { ChalkEmbeddedWhiteboardHostEnvelope } from "./protocol";
import { ChalkEmbeddedWhiteboardRendererBridge } from "./renderer-bridge";
import { applyEmbeddedWhiteboardViewport } from "./renderer-viewport";

const rendererRoot = requireRendererRoot();
const bridge = new ChalkEmbeddedWhiteboardRendererBridge();

type Configuration = {
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly theme: "light" | "dark";
  readonly localParticipantColor?: string;
  readonly board?: ChalkEmbeddedBoardContext;
};

function EmbeddedWhiteboardRenderer(): React.JSX.Element {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [boardContext, setBoardContext] = useState<ChalkEmbeddedBoardContext | null>(null);
  const [following, setFollowing] = useState<string | null>(null);
  const noticeActions = useRef(new Map<string, () => void>());
  const noticeSequence = useRef(0);
  const publishNotice = useCallback((notice: BoardToast | null) => {
    if (!notice) {
      noticeActions.current.clear();
      bridge.post({ type: "notice", payload: null });
      return;
    }
    const id = `notice-${++noticeSequence.current}`;
    if (notice.action) noticeActions.current.set(id, notice.action.onClick);
    if (noticeActions.current.size > 8) {
      const oldest = noticeActions.current.keys().next().value;
      if (oldest) noticeActions.current.delete(oldest);
    }
    bridge.post({ type: "notice", payload: { id, message: typeof notice.message === "string" ? notice.message : "Board updated", kind: notice.type === "error" ? "error" : "info", ...(notice.action ? { actionLabel: notice.action.label } : {}) } });
  }, []);
  const [closed, setClosed] = useState(false);
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const viewportRef = useRef<Extract<ChalkEmbeddedWhiteboardHostEnvelope, { readonly type: "set_viewport" }>["payload"] | null>(null);
  const collaboration = useMemo(() => createCollaborationBridge(bridge), []);

  useEffect(() => {
    const unsubscribe = bridge.subscribe((message) => {
      switch (message.type) {
        case "initialize":
          setConfiguration(requireConfiguration(message.payload));
          if (message.payload.board) {
            setBoardContext(message.payload.board);
            setFollowing(message.payload.board.following);
          }
          return;
        case "set_capabilities":
          setConfiguration((current) => (current ? { ...current, ...requireCapabilities(message.payload) } : current));
          return;
        case "notice_action":
          noticeActions.current.get(message.payload.id)?.();
          return;
        case "set_board":
          setBoardContext(message.payload);
          setFollowing(message.payload.following);
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

  const canvas: WhiteboardCanvasProps = {
    canDraw: configuration.canDraw,
    collab: { ...collaboration, canDraw: configuration.canDraw },
    excalidrawCssPath: "./index.css",
    localParticipantColor: configuration.localParticipantColor,
    onExcalidrawApiReady: (api) => {
      apiRef.current = api;
      applyCurrentViewport(api, viewportRef.current);
    },
    onLoadError: (error) => bridge.post({ type: "error", payload: { code: "renderer_load_failed", message: error.message.slice(0, 256), recoverable: false } }),
  };
  if (!boardContext) return <WhiteboardCanvas {...canvas} isVisible theme={configuration.theme} />;
  const colors = boardContext.colors;
  const style = {
    "--chalk-canvas": colors.canvas,
    "--chalk-surface": colors.surface,
    "--chalk-raised": colors.raised,
    "--chalk-popover": colors.popover,
    "--chalk-hover": colors.hover,
    "--chalk-line": colors.line,
    "--chalk-line-strong": colors.lineStrong,
    "--chalk-text": colors.text,
    "--chalk-text-strong": colors.textStrong,
    "--chalk-muted-text": colors.textMuted,
    "--chalk-soft-text": colors.textSoft,
    "--chalk-danger-text": colors.dangerText,
    "--chalk-focus": colors.focus,
  };
  return (
    <BoardToastContext.Provider value={publishNotice}>
      <div data-chalk style={{ ...style, fontFamily: "Figtree,system-ui,sans-serif" }}>
        <Board
          presentation="mobile"
          board={canvas}
          primary={boardContext.primary}
          phone={boardContext.phone}
          landscapeControlsVisible={boardContext.landscapeControlsVisible}
          visible
          colorScheme={configuration.theme}
          isHost={configuration.canClear}
          connectionStatus={boardContext.connectionStatus}
          sceneId={boardContext.sceneId}
          sceneStatus={boardContext.sceneStatus}
          people={boardContext.people}
          whoCanDraw={
            boardContext.whoCanDraw
              ? {
                  ...boardContext.whoCanDraw,
                  onPolicy: (policy) => {
                    void bridge.setDrawPolicy(policy).catch(() => publishNotice({ type: "error", message: "Could not change who can draw. Try again." }));
                  },
                  onPick: (id, picked) => {
                    void bridge.setDrawPermission(id, picked).catch(() => publishNotice({ type: "error", message: "Could not change who can draw. Try again." }));
                  },
                }
              : undefined
          }
          ownParticipantId={boardContext.ownParticipantId}
          viewBounds={boardContext.viewBounds}
          renderCursorAvatar={(name) => (
            <span className="chalk-board-cursor-avatar">
              <Facehash name={name} size={24} variant="solid" intensity3d="subtle" interactive={false} enableBlink={false} />
            </span>
          )}
          following={following}
          onFollow={(participantId) => {
            setFollowing(participantId);
            bridge.post({ type: "follow", payload: { participantId } });
          }}
          sendView={boardContext.viewsAvailable ? (view) => bridge.sendView(view) : undefined}
          onClose={() => bridge.post({ type: "close_board", payload: {} })}
          downloadLabel="Save or share image"
          onExport={async (image, action) => bridge.exportImage({ format: "png", mimeType: "image/png", dataURL: await blobToDataURL(image), action })}
        />
      </div>
    </BoardToastContext.Provider>
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

function requireConfiguration(value: Extract<ChalkEmbeddedWhiteboardHostEnvelope, { readonly type: "initialize" }>["payload"]): Configuration {
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
