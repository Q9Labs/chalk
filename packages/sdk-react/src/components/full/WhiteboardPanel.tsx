import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawCollabEngine, AppState, BinaryFiles, WhiteboardFileSyncState } from "@q9labs/chalk-whiteboard/collab";

import { cn } from "../../utils/cn";
import { Cancel01Icon, CheckmarkCircle02Icon, Loading01Icon } from "../../utils/icons";
import { appendOrReplaceMathElement, createMathImageAsset, getChalkMathData, getSelectedMathElement } from "./whiteboard-panel/mathElements";
import { renderLatexToSvg } from "./whiteboard-panel/mathjaxRenderer";

const DEFAULT_EXCALIDRAW_CSS = "https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/index.css";
const DEFAULT_LATEX = String.raw`E = mc^2`;

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");
type CollabEngineCtor = typeof import("@q9labs/chalk-whiteboard/collab").ExcalidrawCollabEngine;

export interface WhiteboardCollabOptions {
  canDraw?: boolean;
  sendUpdateV2: (payload: { schemaVersion: 2; sceneId: string; syncAll: boolean; elements: readonly OrderedExcalidrawElement[]; seq: number }) => void;
  sendCursor: (payload: { x: number; y: number }) => void;
  requestSync: () => void;
  sendClear?: () => void;
  presignUpload: (fileId: string, mimeType: string) => Promise<{ uploadUrl: string }>;
  presignDownload: (fileId: string) => Promise<{ downloadUrl: string }>;
  onFileSyncStateChange?: (state: WhiteboardFileSyncState) => void;
}

export interface WhiteboardPanelProps {
  className?: string;
  isVisible?: boolean;
  canDraw?: boolean;
  theme?: "light" | "dark";
  excalidrawCssPath?: string;
  localParticipantColor?: string;
  collab?: WhiteboardCollabOptions;
  onExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
  onLoadError?: (error: Error) => void;
}

function useExternalStylesheet(id: string, href: string) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (typeof document === "undefined") return;

    const existing = document.getElementById(id) as HTMLLinkElement | null;
    if (existing || document.querySelector('link[href*="excalidraw"], style[data-href*="excalidraw"]')) {
      setLoaded(true);
      return;
    }

    const link = document.createElement("link");
    link.id = id;
    link.rel = "stylesheet";
    link.href = href;
    link.onload = () => setLoaded(true);
    link.onerror = () => setError(`Failed to load ${href}`);
    document.head.appendChild(link);

    return () => {
      link.onload = null;
      link.onerror = null;
    };
  }, [href, id]);

  return { loaded, error };
}

function MathDialog({ initialLatex, isEditing, onClose, onSubmit }: { initialLatex: string; isEditing: boolean; onClose: () => void; onSubmit: (latex: string) => Promise<void> }) {
  const [latex, setLatex] = useState(initialLatex);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = latex.trim().length > 0 && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await onSubmit(latex.trim());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to render equation");
      setIsSubmitting(false);
    }
  };

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center bg-background/70 backdrop-blur-sm px-4">
      <div className="w-full max-w-xl rounded-lg border border-border bg-popover shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="text-sm font-medium text-popover-foreground">{isEditing ? "Edit equation" : "Math"}</div>
          <button type="button" onClick={onClose} className="flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground" aria-label="Close math editor">
            <Cancel01Icon className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-4">
          <textarea
            value={latex}
            onChange={(event) => setLatex(event.target.value)}
            className="min-h-28 w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            spellCheck={false}
            autoFocus
            aria-label="LaTeX equation"
          />
          {error && <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="h-9 rounded-md border border-border px-3 text-sm text-muted-foreground hover:bg-accent hover:text-foreground">
              Cancel
            </button>
            <button type="button" onClick={handleSubmit} disabled={!canSubmit} className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50">
              {isSubmitting ? <Loading01Icon className="h-4 w-4 animate-spin" /> : <CheckmarkCircle02Icon className="h-4 w-4" />}
              Insert
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WhiteboardPanelBase({ className, isVisible = true, canDraw: canDrawProp = true, theme = "light", excalidrawCssPath = DEFAULT_EXCALIDRAW_CSS, localParticipantColor, collab, onExcalidrawApiReady, onLoadError }: WhiteboardPanelProps): React.JSX.Element {
  const canDraw = collab?.canDraw ?? canDrawProp;
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const collabEngineRef = useRef<ExcalidrawCollabEngine | null>(null);
  const didReportApiRef = useRef(false);

  const [excalidraw, setExcalidraw] = useState<ExcalidrawModule | null>(null);
  const [collabEngineCtor, setCollabEngineCtor] = useState<CollabEngineCtor | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedLatex, setSelectedLatex] = useState<string | null>(null);
  const [isMathOpen, setIsMathOpen] = useState(false);

  const css = useExternalStylesheet("chalk-excalidraw-styles", excalidrawCssPath);

  useEffect(() => {
    let mounted = true;

    import("@excalidraw/excalidraw")
      .then((module) => {
        if (mounted) setExcalidraw(module);
      })
      .catch((err) => {
        const error = err instanceof Error ? err : new Error("Failed to load whiteboard");
        setLoadError(error.message);
        onLoadError?.(error);
      });

    if (collab) {
      import("@q9labs/chalk-whiteboard/collab")
        .then((module) => {
          if (mounted) setCollabEngineCtor(() => module.ExcalidrawCollabEngine);
        })
        .catch((err) => {
          const error = err instanceof Error ? err : new Error("Failed to load whiteboard sync");
          setLoadError(error.message);
          onLoadError?.(error);
        });
    }

    return () => {
      mounted = false;
    };
  }, [collab, onLoadError]);

  useEffect(() => {
    collabEngineRef.current?.setCanDraw(canDraw);
  }, [canDraw]);

  useEffect(
    () => () => {
      collabEngineRef.current?.dispose();
      collabEngineRef.current = null;
    },
    [],
  );

  const initializeCollabEngine = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      if (!collab || !collabEngineCtor || collabEngineRef.current) return;

      collabEngineRef.current = new collabEngineCtor({
        excalidrawAPI: api,
        canDraw,
        sendUpdateV2: collab.sendUpdateV2,
        sendCursor: collab.sendCursor,
        requestSync: collab.requestSync,
        sendClear: collab.sendClear,
        presignUpload: collab.presignUpload,
        presignDownload: collab.presignDownload,
        onFileSyncStateChange: collab.onFileSyncStateChange,
      });
    },
    [canDraw, collab, collabEngineCtor],
  );

  const handleApiReady = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      initializeCollabEngine(api);

      if (!didReportApiRef.current) {
        didReportApiRef.current = true;
        onExcalidrawApiReady?.(api);
      }
    },
    [initializeCollabEngine, onExcalidrawApiReady],
  );

  const handleChange = useCallback((elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
    collabEngineRef.current?.handleChange(elements, appState, files);

    const selected = apiRef.current ? getSelectedMathElement(apiRef.current) : null;
    setSelectedLatex(selected ? (getChalkMathData(selected)?.latex ?? null) : null);
  }, []);

  const handlePointerUpdate = useCallback((payload: { pointer: { x: number; y: number } }) => {
    collabEngineRef.current?.handlePointerUpdate(payload);
  }, []);

  const openMath = useCallback(() => {
    if (!canDraw) return;
    setIsMathOpen(true);
  }, [canDraw]);

  const handleSubmitMath = useCallback(
    async (latex: string) => {
      const api = apiRef.current;
      if (!api || !excalidraw) throw new Error("Whiteboard is still loading");

      const existingElement = getSelectedMathElement(api);
      const rendered = await renderLatexToSvg(latex, true);
      const asset = createMathImageAsset({
        svg: rendered.svg,
        width: rendered.width,
        height: rendered.height,
        latex,
        displayMode: true,
      });

      appendOrReplaceMathElement({
        api,
        excalidraw,
        asset,
        existingElement,
        status: collab ? "pending" : "saved",
      });

      setSelectedLatex(latex);
      setIsMathOpen(false);
      collabEngineRef.current?.handleChange(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles());
    },
    [collab, excalidraw],
  );

  const resolvedLoadError = loadError ?? css.error;
  const isReady = Boolean(excalidraw && css.loaded && !resolvedLoadError);

  const initialData = useMemo(
    () => ({
      appState: {
        viewBackgroundColor: theme === "dark" ? "#000000" : "#ffffff",
        currentItemStrokeColor: localParticipantColor ?? "#4CB9FF",
        theme,
      },
    }),
    [localParticipantColor, theme],
  );

  const uiOptions = useMemo(
    () => ({
      canvasActions: {
        changeViewBackgroundColor: false,
        clearCanvas: false,
        export: false as const,
        loadScene: false,
        saveAsImage: false,
        saveToActiveFile: false,
        toggleTheme: false,
      },
      tools: {
        image: canDraw,
      },
      welcomeScreen: false,
    }),
    [canDraw],
  );

  return (
    <div className={cn("relative flex min-h-[420px] min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-background", !isVisible && "hidden", className)}>
      {isReady && (
        <div className="absolute left-3 top-3 z-20 flex items-center gap-2 rounded-lg border border-border bg-popover/95 p-1 shadow-sm">
          <button
            type="button"
            onClick={openMath}
            disabled={!canDraw}
            className="flex h-8 min-w-8 items-center justify-center rounded-md px-2 text-sm font-semibold text-popover-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={selectedLatex ? "Edit math equation" : "Insert math equation"}
            title={selectedLatex ? "Edit equation" : "Math"}
          >
            ∑
          </button>
        </div>
      )}

      {!isReady && !resolvedLoadError && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background text-foreground">
          <div className="flex items-center gap-3 text-sm text-muted-foreground">
            <Loading01Icon className="h-5 w-5 animate-spin" />
            Loading whiteboard...
          </div>
        </div>
      )}

      {resolvedLoadError && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-background p-6 text-center text-destructive">
          <div className="max-w-md text-sm">{resolvedLoadError}</div>
        </div>
      )}

      {excalidraw && (
        <excalidraw.Excalidraw
          excalidrawAPI={handleApiReady}
          initialData={initialData}
          isCollaborating={Boolean(collab)}
          name="Chalk whiteboard"
          onChange={handleChange}
          onPointerUpdate={handlePointerUpdate}
          renderTopRightUI={() => null}
          theme={theme}
          UIOptions={uiOptions}
          viewModeEnabled={!canDraw}
        />
      )}

      {isMathOpen && <MathDialog initialLatex={selectedLatex ?? DEFAULT_LATEX} isEditing={Boolean(selectedLatex)} onClose={() => setIsMathOpen(false)} onSubmit={handleSubmitMath} />}
    </div>
  );
}

export const WhiteboardPanel = memo(WhiteboardPanelBase);
WhiteboardPanel.displayName = "WhiteboardPanel";
