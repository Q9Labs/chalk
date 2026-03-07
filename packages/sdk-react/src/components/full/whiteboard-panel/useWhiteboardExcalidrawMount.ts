import { createElement, useEffect, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { AppState, OrderedExcalidrawElement } from "@q9labs/chalk-whiteboard/collab";

import type { BinaryFiles, CollabEngine, WhiteboardEngineRefs, WhiteboardSessionLike } from "./types";

interface UseWhiteboardExcalidrawMountParams {
  canDraw: boolean;
  resolvedTheme: "light" | "dark";
  excalidrawCssPath: string;
  session: WhiteboardSessionLike;
  onExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
}

export function useWhiteboardExcalidrawMount({ canDraw, resolvedTheme, excalidrawCssPath, session, onExcalidrawApiReady }: UseWhiteboardExcalidrawMountParams) {
  const collabEngineRef = useRef<CollabEngine | null>(null);
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
        const collabPromise = import("@q9labs/chalk-whiteboard/collab").catch(() => null);

        const [{ Excalidraw }, { createRoot }, chalkWhiteboardCollab] = await Promise.all([import("@excalidraw/excalidraw"), import("react-dom/client"), collabPromise]);

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
        root = createRoot(containerRef.current);

        const ExcalidrawWrapper = () => {
          const handleChange = (elements: readonly unknown[], appState: unknown, files: BinaryFiles) => {
            collabEngineRef.current?.handleChange(elements as readonly OrderedExcalidrawElement[], appState as AppState, files);
          };

          const handlePointerUpdate = (payload: { pointer: { x: number; y: number } }) => {
            collabEngineRef.current?.handlePointerUpdate(payload);
          };

          const isDark = resolvedTheme === "dark";
          const backgroundColor = isDark ? "#000" : "#0000";
          const strokeColor = "#4CB9FF";

          return createElement(Excalidraw, {
            excalidrawAPI: (api: unknown) => {
              if (!didReportApiRef.current && onExcalidrawApiReady && api) {
                didReportApiRef.current = true;
                onExcalidrawApiReady(api as ExcalidrawImperativeAPI);
              }

              if (!collabEngineRef.current && CollabEngineCtor) {
                collabEngineRef.current = new CollabEngineCtor({
                  excalidrawAPI: api as ExcalidrawImperativeAPI,
                  canDraw,
                  sendUpdateV2: (payload: { schemaVersion: 2; sceneId: string; syncAll: boolean; elements: readonly OrderedExcalidrawElement[]; seq: number }) => {
                    const room = session.room.getRoom();
                    room?.sendWhiteboardUpdateV2({
                      sceneId: payload.sceneId,
                      syncAll: payload.syncAll,
                      elements: payload.elements,
                      seq: payload.seq,
                    });
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
      setTimeout(() => {
        root?.unmount();
      }, 0);
    };
  }, [canDraw, excalidrawCssPath, onExcalidrawApiReady, resolvedTheme, session]);

  const refs: WhiteboardEngineRefs = {
    collabEngineRef,
  };

  return {
    refs,
    containerRef,
    isReady,
    cssLoaded,
    loadError,
  };
}
