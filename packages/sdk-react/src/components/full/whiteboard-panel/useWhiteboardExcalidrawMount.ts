import { createElement, useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import type { BinaryFiles, CollabEngine, ExcalidrawElement, SyncEngine, WhiteboardEngineRefs, WhiteboardSessionLike } from "./types";

interface UseWhiteboardExcalidrawMountParams {
  useV2: boolean;
  canDraw: boolean;
  resolvedTheme: "light" | "dark";
  excalidrawCssPath: string;
  session: WhiteboardSessionLike;
  sendUpdate: (elements: unknown[], files?: Record<string, unknown>, seq?: number) => void;
  sendCursor: (x: number, y: number) => void;
  onExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
}

export function useWhiteboardExcalidrawMount({ useV2, canDraw, resolvedTheme, excalidrawCssPath, session, sendUpdate, sendCursor, onExcalidrawApiReady }: UseWhiteboardExcalidrawMountParams) {
  const syncEngineRef = useRef<SyncEngine | null>(null);
  const collabEngineRef = useRef<CollabEngine | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const excalidrawRef = useRef<any>(null);
  const elementsRef = useRef<readonly ExcalidrawElement[]>([]);
  const filesRef = useRef<Record<string, unknown>>({});
  const containerRef = useRef<HTMLDivElement>(null);
  const didReportApiRef = useRef(false);

  const [isReady, setIsReady] = useState(false);
  const [cssLoaded, setCssLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !containerRef.current) return;

    let mounted = true;
    let root: ReturnType<typeof import("react-dom/client").createRoot> | null = null;

    const loadExcalidraw = async () => {
      try {
        const collabPromise = useV2 ? import("@q9labs/chalk-whiteboard/collab").catch(() => null) : Promise.resolve(null);
        const legacyPromise = useV2 ? Promise.resolve(null) : import("@q9labs/chalk-whiteboard").catch(() => null);

        const [{ Excalidraw }, { createRoot }, chalkWhiteboardCollab, chalkWhiteboardLegacy] = await Promise.all([import("@excalidraw/excalidraw"), import("react-dom/client"), collabPromise, legacyPromise]);

        const cssId = "excalidraw-styles";
        const existingLink = document.getElementById(cssId) as HTMLLinkElement | null;
        const hasGlobalStyles = document.querySelector('style[data-href*="excalidraw"], link[href*="excalidraw"]');

        if (existingLink || hasGlobalStyles) {
          setCssLoaded(true);
        } else {
          const link = document.createElement("link");
          link.id = cssId;
          link.rel = "stylesheet";
          link.href = excalidrawCssPath;
          link.onload = () => setCssLoaded(true);
          document.head.appendChild(link);
        }

        if (!mounted || !containerRef.current) return;

        const CollabEngineCtor = chalkWhiteboardCollab?.ExcalidrawCollabEngine;
        const SyncEngineCtor = chalkWhiteboardLegacy?.SyncEngine;
        root = createRoot(containerRef.current);

        const ExcalidrawWrapper = () => {
          const handleChange = (elements: readonly unknown[], appState: unknown, files: BinaryFiles) => {
            if (useV2) {
              collabEngineRef.current?.handleChange(elements, appState, files);
              return;
            }

            if (!canDraw) return;
            elementsRef.current = elements as readonly ExcalidrawElement[];
            syncEngineRef.current?.handleChange(elements as readonly ExcalidrawElement[], files);
          };

          const handlePointerUpdate = (payload: { pointer: { x: number; y: number } }) => {
            if (useV2) {
              collabEngineRef.current?.handlePointerUpdate(payload);
              return;
            }
            syncEngineRef.current?.sendCursor(payload.pointer.x, payload.pointer.y);
          };

          const isDark = resolvedTheme === "dark";
          const backgroundColor = isDark ? "#000" : "#0000";
          const strokeColor = "#4CB9FF";

          return createElement(Excalidraw, {
            excalidrawAPI: (api: unknown) => {
              excalidrawRef.current = api;
              if (!didReportApiRef.current && onExcalidrawApiReady && api) {
                didReportApiRef.current = true;
                onExcalidrawApiReady(api as ExcalidrawImperativeAPI);
              }

              if (useV2 && !collabEngineRef.current && CollabEngineCtor) {
                collabEngineRef.current = new CollabEngineCtor({
                  excalidrawAPI: api as ExcalidrawImperativeAPI,
                  canDraw,
                  sendUpdateV2: (payload: { sceneId?: string; syncAll?: boolean; elements: readonly unknown[]; seq?: number }) => {
                    const room = session.room.getRoom();
                    room?.sendWhiteboardUpdateV2({ sceneId: payload.sceneId, syncAll: payload.syncAll, elements: payload.elements, seq: payload.seq });
                  },
                  sendCursor: (payload: { x: number; y: number }) => {
                    const room = session.room.getRoom();
                    room?.sendWhiteboardCursor(payload.x, payload.y);
                  },
                  requestSync: () => {
                    const room = session.room.getRoom();
                    room?.requestWhiteboardSync();
                  },
                  sendClear: () => {
                    const room = session.room.getRoom();
                    room?.clearWhiteboard();
                  },
                  presignUpload: async (fileId: string, mimeType: string) => {
                    const response = await session.whiteboardPresignUpload(fileId, mimeType);
                    return { uploadUrl: response.uploadUrl };
                  },
                  presignDownload: async (fileId: string) => {
                    const response = await session.whiteboardPresignDownload(fileId);
                    return { downloadUrl: response.downloadUrl };
                  },
                });
              }

              if (!useV2 && !syncEngineRef.current && SyncEngineCtor) {
                syncEngineRef.current = new SyncEngineCtor(
                  (type: string, payload: unknown) => {
                    if (type === "whiteboard.update") {
                      const whiteboardPayload = payload as { elements: unknown[]; files?: Record<string, unknown>; seq: number };
                      sendUpdate(whiteboardPayload.elements, whiteboardPayload.files, whiteboardPayload.seq);
                    } else if (type === "whiteboard.cursor") {
                      const cursorPayload = payload as { x: number; y: number };
                      sendCursor(cursorPayload.x, cursorPayload.y);
                    }
                  },
                  {
                    debounceMs: 150,
                    cursorThrottleMs: 16,
                    maxPayloadBytes: 32 * 1024 * 1024,
                    maxFileBytes: 32 * 1024 * 1024,
                  },
                );
              }
            },
            isCollaborating: true,
            theme: resolvedTheme,
            initialData: {
              appState: {
                viewBackgroundColor: backgroundColor,
                theme: resolvedTheme,
                currentItemStrokeColor: strokeColor,
              },
            },
            onChange: handleChange,
            onPointerUpdate: handlePointerUpdate,
            viewModeEnabled: !canDraw,
            UIOptions: {
              canvasActions: {
                changeViewBackgroundColor: canDraw,
                clearCanvas: canDraw,
                export: {},
                loadScene: false,
                saveToActiveFile: false,
                toggleTheme: false,
              },
            },
            renderTopRightUI: () => null,
          });
        };

        root.render(createElement(ExcalidrawWrapper));
        setIsReady(true);
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : "Failed to load whiteboard");
      }
    };

    void loadExcalidraw();

    return () => {
      mounted = false;
      collabEngineRef.current?.dispose?.();
      collabEngineRef.current = null;
      syncEngineRef.current?.reset?.();
      syncEngineRef.current = null;
      setTimeout(() => {
        root?.unmount();
      }, 0);
    };
  }, [canDraw, excalidrawCssPath, onExcalidrawApiReady, resolvedTheme, sendCursor, sendUpdate, session, useV2]);

  const refs: WhiteboardEngineRefs = {
    syncEngineRef,
    collabEngineRef,
    excalidrawRef,
    elementsRef,
    filesRef,
  };

  return {
    refs,
    containerRef,
    isReady,
    cssLoaded,
    loadError,
  };
}
