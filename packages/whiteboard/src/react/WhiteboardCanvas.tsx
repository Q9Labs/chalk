import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { ExcalidrawCollabEngine, ExcalidrawCollabEngineOptions } from "../collab/engine.js";
import type { AppState, BinaryFiles } from "../collab/types.js";
import { MathEditor } from "./MathEditor.js";
import { appendOrReplaceMathElement, createMathImageAsset, getChalkMathData, getSelectedMathElement } from "./math-elements.js";
import { renderLatexToSvg } from "./mathjax-renderer.js";

const DEFAULT_EXCALIDRAW_CSS = "https://cdn.jsdelivr.net/npm/@excalidraw/excalidraw@0.18.1/dist/prod/index.css";
const DEFAULT_LATEX = String.raw`E = mc^2`;

type ExcalidrawModule = typeof import("@excalidraw/excalidraw");
export interface WhiteboardCollaborationOptions extends Omit<ExcalidrawCollabEngineOptions, "excalidrawAPI" | "canDraw"> {
  canDraw?: boolean;
}

export interface WhiteboardCanvasClassNames {
  root: string;
  toolbar: string;
  toolbarButton: string;
  loading: string;
  loadingContent: string;
  error: string;
  mathOverlay: string;
  mathDialog: string;
  mathHeader: string;
  mathTitle: string;
  mathCloseButton: string;
  mathBody: string;
  mathTextarea: string;
  mathError: string;
  mathActions: string;
  mathCancelButton: string;
  mathSubmitButton: string;
}

export interface WhiteboardCanvasIcons {
  close?: ReactNode;
  loading?: ReactNode;
  submit?: ReactNode;
  submitting?: ReactNode;
}

export interface WhiteboardCanvasProps {
  className?: string;
  isVisible?: boolean;
  canDraw?: boolean;
  theme?: "light" | "dark";
  excalidrawCssPath?: string;
  localParticipantColor?: string;
  collab?: WhiteboardCollaborationOptions;
  classNames?: Partial<WhiteboardCanvasClassNames>;
  icons?: WhiteboardCanvasIcons;
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

const defaultClassNames: WhiteboardCanvasClassNames = {
  root: "",
  toolbar: "",
  toolbarButton: "",
  loading: "",
  loadingContent: "",
  error: "",
  mathOverlay: "",
  mathDialog: "",
  mathHeader: "",
  mathTitle: "",
  mathCloseButton: "",
  mathBody: "",
  mathTextarea: "",
  mathError: "",
  mathActions: "",
  mathCancelButton: "",
  mathSubmitButton: "",
};

// This component coordinates one lifecycle across Excalidraw, collaboration, and math state.
// fallow-ignore-next-line complexity
function WhiteboardCanvasBase({
  className,
  isVisible = true,
  canDraw: canDrawProp = true,
  theme = "light",
  excalidrawCssPath = DEFAULT_EXCALIDRAW_CSS,
  localParticipantColor,
  collab,
  classNames: classNameOverrides,
  icons = {},
  onExcalidrawApiReady,
  onLoadError,
}: WhiteboardCanvasProps): React.JSX.Element {
  const canDraw = collab?.canDraw ?? canDrawProp;
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const isMountedRef = useRef(true);
  const collabOptionsRef = useRef(collab);
  const canDrawRef = useRef(canDraw);
  const collabEngineRef = useRef<ExcalidrawCollabEngine | null>(null);
  const collabEnginePromiseRef = useRef<Promise<void> | null>(null);
  const didReportApiRef = useRef(false);

  const [excalidraw, setExcalidraw] = useState<ExcalidrawModule | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedLatex, setSelectedLatex] = useState<string | null>(null);
  const [isMathOpen, setIsMathOpen] = useState(false);
  const classNames = useMemo(() => ({ ...defaultClassNames, ...classNameOverrides }), [classNameOverrides]);

  collabOptionsRef.current = collab;
  canDrawRef.current = canDraw;

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

    return () => {
      mounted = false;
    };
  }, [onLoadError]);

  useEffect(() => {
    collabEngineRef.current?.setCanDraw(canDraw);
  }, [canDraw]);

  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      collabEngineRef.current?.dispose();
      collabEngineRef.current = null;
    };
  }, []);

  const initializeCollabEngine = useCallback(
    (api: ExcalidrawImperativeAPI) => {
      if (!collabOptionsRef.current || collabEngineRef.current || collabEnginePromiseRef.current) return;

      collabEnginePromiseRef.current = import("../collab/engine.js")
        .then(({ ExcalidrawCollabEngine }) => {
          const currentCollab = collabOptionsRef.current;
          if (!isMountedRef.current || !currentCollab || collabEngineRef.current) return;

          collabEngineRef.current = new ExcalidrawCollabEngine({
            excalidrawAPI: api,
            canDraw: canDrawRef.current,
            sendUpdateV2: currentCollab.sendUpdateV2,
            sendCursor: currentCollab.sendCursor,
            requestSync: currentCollab.requestSync,
            sendClear: currentCollab.sendClear,
            presignUpload: currentCollab.presignUpload,
            presignDownload: currentCollab.presignDownload,
            onFileSyncStateChange: currentCollab.onFileSyncStateChange,
          });
        })
        .catch((importError: unknown) => {
          if (!isMountedRef.current) return;

          const error = importError instanceof Error ? importError : new Error("Failed to load whiteboard collaboration");
          setLoadError(error.message);
          onLoadError?.(error);
        })
        .finally(() => {
          collabEnginePromiseRef.current = null;
        });
    },
    [onLoadError],
  );

  useEffect(() => {
    if (!collab) {
      collabEngineRef.current?.dispose();
      collabEngineRef.current = null;
      return;
    }

    if (apiRef.current) initializeCollabEngine(apiRef.current);
  }, [collab, initializeCollabEngine]);

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

  // Scene synchronization and selection tracking intentionally share the Excalidraw callback.
  // fallow-ignore-next-line complexity
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
    <div className={[classNames.root, className ?? ""].filter(Boolean).join(" ")} hidden={!isVisible}>
      {isReady && (
        <div className={classNames.toolbar} style={{ position: "absolute", top: 12, left: 12, zIndex: 20, display: "flex" }}>
          <button type="button" onClick={openMath} disabled={!canDraw} className={classNames.toolbarButton} aria-label={selectedLatex ? "Edit math equation" : "Insert math equation"} title={selectedLatex ? "Edit equation" : "Math"}>
            ∑
          </button>
        </div>
      )}

      {!isReady && !resolvedLoadError && (
        <div className={classNames.loading} style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className={classNames.loadingContent}>
            {icons.loading}
            Loading whiteboard...
          </div>
        </div>
      )}

      {resolvedLoadError && (
        <div className={classNames.error} style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div>{resolvedLoadError}</div>
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

      {isMathOpen && <MathEditor initialLatex={selectedLatex ?? DEFAULT_LATEX} isEditing={Boolean(selectedLatex)} classNames={classNames} icons={icons} onClose={() => setIsMathOpen(false)} onSubmit={handleSubmitMath} />}
    </div>
  );
}

export const WhiteboardCanvas = memo(WhiteboardCanvasBase);
WhiteboardCanvas.displayName = "WhiteboardCanvas";
