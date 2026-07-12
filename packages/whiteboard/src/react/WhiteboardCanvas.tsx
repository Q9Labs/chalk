import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
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

interface WhiteboardCanvasConfiguration {
  canDraw: boolean;
  classNames: WhiteboardCanvasClassNames;
  excalidrawCssPath: string;
  icons: WhiteboardCanvasIcons;
  isCollaborating: boolean;
  isVisible: boolean;
  rootClassName: string;
  theme: "light" | "dark";
}

interface ExternalStylesheetState {
  error: string | null;
  loaded: boolean;
}

interface CollaborationRefs {
  canDrawRef: MutableRefObject<boolean>;
  collabOptionsRef: MutableRefObject<WhiteboardCollaborationOptions | undefined>;
  enginePromiseRef: MutableRefObject<Promise<void> | null>;
  engineRef: MutableRefObject<ExcalidrawCollabEngine | null>;
  isMountedRef: MutableRefObject<boolean>;
}

interface WhiteboardCollaboration {
  apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>;
  handleApiReady: (api: ExcalidrawImperativeAPI) => void;
  handleChange: (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => void;
  handlePointerUpdate: (payload: { pointer: { x: number; y: number } }) => void;
  syncScene: () => void;
}

interface WhiteboardMath {
  closeMath: () => void;
  handleSubmitMath: (latex: string) => Promise<void>;
  isMathOpen: boolean;
  openMath: () => void;
  selectedLatex: string | null;
}

interface UseWhiteboardMathOptions {
  apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>;
  canDraw: boolean;
  excalidraw: ExcalidrawModule | null;
  isCollaborating: boolean;
  selectedLatex: string | null;
  setSelectedLatex: (latex: string | null) => void;
  syncScene: () => void;
}

function useWhiteboardCanvasConfiguration(props: WhiteboardCanvasProps): WhiteboardCanvasConfiguration {
  const classNames = useMemo(() => ({ ...defaultClassNames, ...props.classNames }), [props.classNames]);
  const canDraw = valueOr(props.collab?.canDraw, valueOr(props.canDraw, true));
  const rootClassName = [classNames.root, valueOr(props.className, "")].filter(Boolean).join(" ");

  return {
    canDraw,
    classNames,
    excalidrawCssPath: valueOr(props.excalidrawCssPath, DEFAULT_EXCALIDRAW_CSS),
    icons: valueOr(props.icons, {}),
    isCollaborating: Boolean(props.collab),
    isVisible: valueOr(props.isVisible, true),
    rootClassName,
    theme: valueOr(props.theme, "light"),
  };
}

function valueOr<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

function useExternalStylesheet(id: string, href: string): ExternalStylesheetState {
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

  return { error, loaded };
}

function useExcalidrawModule(onLoadError: ((error: Error) => void) | undefined, setLoadError: (message: string) => void): ExcalidrawModule | null {
  const [excalidraw, setExcalidraw] = useState<ExcalidrawModule | null>(null);

  useEffect(() => {
    let mounted = true;

    import("@excalidraw/excalidraw")
      .then((module) => {
        if (mounted) setExcalidraw(module);
      })
      .catch((reason: unknown) => {
        const error = reason instanceof Error ? reason : new Error("Failed to load whiteboard");
        setLoadError(error.message);
        onLoadError?.(error);
      });

    return () => {
      mounted = false;
    };
  }, [onLoadError, setLoadError]);

  return excalidraw;
}

function useWhiteboardInitialData(theme: "light" | "dark", localParticipantColor?: string) {
  return useMemo(
    () => ({
      appState: {
        viewBackgroundColor: theme === "dark" ? "#000000" : "#ffffff",
        currentItemStrokeColor: localParticipantColor ?? "#4CB9FF",
        theme,
      },
    }),
    [localParticipantColor, theme],
  );
}

function useWhiteboardUiOptions(canDraw: boolean) {
  return useMemo(
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
      tools: { image: canDraw },
      welcomeScreen: false,
    }),
    [canDraw],
  );
}

function useWhiteboardCollaboration(options: {
  canDraw: boolean;
  collab?: WhiteboardCollaborationOptions;
  onExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
  onLoadError?: (error: Error) => void;
  onSelectedLatexChange: (latex: string | null) => void;
  setLoadError: (message: string) => void;
}): WhiteboardCollaboration {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const refs = useCollaborationRefs(options.collab, options.canDraw);
  const initializeEngine = useCollaborationEngineLoader(refs, options.onLoadError, options.setLoadError);
  const handleApiReady = useExcalidrawApiReady(apiRef, initializeEngine, options.onExcalidrawApiReady);
  const handlers = useExcalidrawSceneHandlers(apiRef, refs.engineRef, options.onSelectedLatexChange);

  useCollaborationCanDraw(refs.engineRef, options.canDraw);
  useCollaborationDisposal(refs.engineRef, refs.isMountedRef);
  useCollaborationInitialization(options.collab, apiRef, refs.engineRef, initializeEngine);

  return { apiRef, handleApiReady, ...handlers };
}

function useCollaborationRefs(collab: WhiteboardCollaborationOptions | undefined, canDraw: boolean): CollaborationRefs {
  const canDrawRef = useRef(canDraw);
  const collabOptionsRef = useRef(collab);
  const enginePromiseRef = useRef<Promise<void> | null>(null);
  const engineRef = useRef<ExcalidrawCollabEngine | null>(null);
  const isMountedRef = useRef(true);

  canDrawRef.current = canDraw;
  collabOptionsRef.current = collab;

  return useMemo(() => ({ canDrawRef, collabOptionsRef, enginePromiseRef, engineRef, isMountedRef }), [canDrawRef, collabOptionsRef, enginePromiseRef, engineRef, isMountedRef]);
}

function useCollaborationEngineLoader(refs: CollaborationRefs, onLoadError: ((error: Error) => void) | undefined, setLoadError: (message: string) => void) {
  return useCallback(
    (api: ExcalidrawImperativeAPI) => {
      if (!refs.collabOptionsRef.current || refs.engineRef.current || refs.enginePromiseRef.current) return;

      refs.enginePromiseRef.current = import("../collab/engine.js")
        .then(({ ExcalidrawCollabEngine }) => {
          const collab = refs.collabOptionsRef.current;
          if (!refs.isMountedRef.current || !collab || refs.engineRef.current) return;

          refs.engineRef.current = new ExcalidrawCollabEngine({
            excalidrawAPI: api,
            canDraw: refs.canDrawRef.current,
            sendUpdateV2: collab.sendUpdateV2,
            sendCursor: collab.sendCursor,
            requestSync: collab.requestSync,
            sendClear: collab.sendClear,
            presignUpload: collab.presignUpload,
            presignDownload: collab.presignDownload,
            onFileSyncStateChange: collab.onFileSyncStateChange,
          });
        })
        .catch((reason: unknown) => {
          if (!refs.isMountedRef.current) return;

          const error = reason instanceof Error ? reason : new Error("Failed to load whiteboard collaboration");
          setLoadError(error.message);
          onLoadError?.(error);
        })
        .finally(() => {
          refs.enginePromiseRef.current = null;
        });
    },
    [onLoadError, refs, setLoadError],
  );
}

function useExcalidrawApiReady(apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>, initializeEngine: (api: ExcalidrawImperativeAPI) => void, onExcalidrawApiReady: ((api: ExcalidrawImperativeAPI) => void) | undefined) {
  const didReportApiRef = useRef(false);

  return useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      initializeEngine(api);

      if (!didReportApiRef.current) {
        didReportApiRef.current = true;
        onExcalidrawApiReady?.(api);
      }
    },
    [apiRef, initializeEngine, onExcalidrawApiReady],
  );
}

function useExcalidrawSceneHandlers(apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>, engineRef: MutableRefObject<ExcalidrawCollabEngine | null>, onSelectedLatexChange: (latex: string | null) => void) {
  const handleChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      engineRef.current?.handleChange(elements, appState, files);
      onSelectedLatexChange(selectedMathLatex(apiRef.current));
    },
    [apiRef, engineRef, onSelectedLatexChange],
  );
  const handlePointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number } }) => {
      engineRef.current?.handlePointerUpdate(payload);
    },
    [engineRef],
  );
  const syncScene = useCallback(() => {
    const api = apiRef.current;
    if (!api) return;

    engineRef.current?.handleChange(api.getSceneElementsIncludingDeleted(), api.getAppState(), api.getFiles());
  }, [apiRef, engineRef]);

  return { handleChange, handlePointerUpdate, syncScene };
}

function selectedMathLatex(api: ExcalidrawImperativeAPI | null): string | null {
  if (!api) return null;

  const selected = getSelectedMathElement(api);
  if (!selected) return null;

  const math = getChalkMathData(selected);
  return math ? math.latex : null;
}

function useCollaborationCanDraw(engineRef: MutableRefObject<ExcalidrawCollabEngine | null>, canDraw: boolean) {
  useEffect(() => {
    engineRef.current?.setCanDraw(canDraw);
  }, [canDraw, engineRef]);
}

function useCollaborationDisposal(engineRef: MutableRefObject<ExcalidrawCollabEngine | null>, isMountedRef: MutableRefObject<boolean>) {
  useEffect(() => {
    isMountedRef.current = true;

    return () => {
      isMountedRef.current = false;
      engineRef.current?.dispose();
      engineRef.current = null;
    };
  }, [engineRef, isMountedRef]);
}

function useCollaborationInitialization(collab: WhiteboardCollaborationOptions | undefined, apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>, engineRef: MutableRefObject<ExcalidrawCollabEngine | null>, initializeEngine: (api: ExcalidrawImperativeAPI) => void) {
  useEffect(() => {
    if (!collab) {
      engineRef.current?.dispose();
      engineRef.current = null;
      return;
    }

    if (apiRef.current) initializeEngine(apiRef.current);
  }, [apiRef, collab, engineRef, initializeEngine]);
}

function useWhiteboardMath({ apiRef, canDraw, excalidraw, isCollaborating, selectedLatex, setSelectedLatex, syncScene }: UseWhiteboardMathOptions): WhiteboardMath {
  const [isMathOpen, setIsMathOpen] = useState(false);
  const closeMath = useCallback(() => setIsMathOpen(false), []);
  const openMath = useCallback(() => {
    if (canDraw) setIsMathOpen(true);
  }, [canDraw]);
  const handleSubmitMath = useCallback(
    async (latex: string) => {
      const api = apiRef.current;
      if (!api || !excalidraw) throw new Error("Whiteboard is still loading");

      const rendered = await renderLatexToSvg(latex, true);
      appendOrReplaceMathElement({
        api,
        excalidraw,
        asset: createMathImageAsset({ ...rendered, latex, displayMode: true }),
        existingElement: getSelectedMathElement(api),
        status: isCollaborating ? "pending" : "saved",
      });
      setSelectedLatex(latex);
      closeMath();
      syncScene();
    },
    [apiRef, closeMath, excalidraw, isCollaborating, setSelectedLatex, syncScene],
  );

  return { closeMath, handleSubmitMath, isMathOpen, openMath, selectedLatex };
}

function useWhiteboardCanvasState(props: WhiteboardCanvasProps) {
  const configuration = useWhiteboardCanvasConfiguration(props);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedLatex, setSelectedLatex] = useState<string | null>(null);
  const excalidraw = useExcalidrawModule(props.onLoadError, setLoadError);
  const stylesheet = useExternalStylesheet("chalk-excalidraw-styles", configuration.excalidrawCssPath);
  const collaboration = useWhiteboardCollaboration({
    canDraw: configuration.canDraw,
    collab: props.collab,
    onExcalidrawApiReady: props.onExcalidrawApiReady,
    onLoadError: props.onLoadError,
    onSelectedLatexChange: setSelectedLatex,
    setLoadError,
  });
  const math = useWhiteboardMath({
    apiRef: collaboration.apiRef,
    canDraw: configuration.canDraw,
    excalidraw,
    isCollaborating: Boolean(props.collab),
    selectedLatex,
    setSelectedLatex,
    syncScene: collaboration.syncScene,
  });
  const initialData = useWhiteboardInitialData(configuration.theme, props.localParticipantColor);
  const uiOptions = useWhiteboardUiOptions(configuration.canDraw);
  const resolvedLoadError = loadError ?? stylesheet.error;

  return {
    collaboration,
    configuration,
    excalidraw,
    initialData,
    isReady: Boolean(excalidraw && stylesheet.loaded && !resolvedLoadError),
    math,
    resolvedLoadError,
    uiOptions,
  };
}

function WhiteboardCanvasView({ state }: { state: ReturnType<typeof useWhiteboardCanvasState> }): React.JSX.Element {
  const { collaboration, configuration, excalidraw, initialData, isReady, math, resolvedLoadError, uiOptions } = state;

  return (
    <div className={configuration.rootClassName} hidden={!configuration.isVisible}>
      <WhiteboardMathToolbar canDraw={configuration.canDraw} classNames={configuration.classNames} isReady={isReady} onOpenMath={math.openMath} selectedLatex={math.selectedLatex} />
      <WhiteboardCanvasStatus classNames={configuration.classNames} error={resolvedLoadError} icons={configuration.icons} isReady={isReady} />
      {excalidraw && (
        <WhiteboardScene
          canDraw={configuration.canDraw}
          collab={configuration.isCollaborating}
          excalidraw={excalidraw}
          initialData={initialData}
          onApiReady={collaboration.handleApiReady}
          onChange={collaboration.handleChange}
          onPointerUpdate={collaboration.handlePointerUpdate}
          theme={configuration.theme}
          uiOptions={uiOptions}
        />
      )}
      {math.isMathOpen && <MathEditor initialLatex={math.selectedLatex ?? DEFAULT_LATEX} isEditing={Boolean(math.selectedLatex)} classNames={configuration.classNames} icons={configuration.icons} onClose={math.closeMath} onSubmit={math.handleSubmitMath} />}
    </div>
  );
}

function WhiteboardMathToolbar({ canDraw, classNames, isReady, onOpenMath, selectedLatex }: { canDraw: boolean; classNames: WhiteboardCanvasClassNames; isReady: boolean; onOpenMath: () => void; selectedLatex: string | null }): React.JSX.Element | null {
  if (!isReady) return null;

  return (
    <div className={classNames.toolbar} style={{ position: "absolute", top: 12, left: 12, zIndex: 20, display: "flex" }}>
      <button type="button" onClick={onOpenMath} disabled={!canDraw} className={classNames.toolbarButton} aria-label={selectedLatex ? "Edit math equation" : "Insert math equation"} title={selectedLatex ? "Edit equation" : "Math"}>
        ∑
      </button>
    </div>
  );
}

function WhiteboardCanvasStatus({ classNames, error, icons, isReady }: { classNames: WhiteboardCanvasClassNames; error: string | null; icons: WhiteboardCanvasIcons; isReady: boolean }): React.JSX.Element | null {
  if (error) return <WhiteboardLoadError className={classNames.error} error={error} />;
  if (isReady) return null;

  return <WhiteboardLoading classNames={classNames} loadingIcon={icons.loading} />;
}

function WhiteboardLoading({ classNames, loadingIcon }: { classNames: WhiteboardCanvasClassNames; loadingIcon: ReactNode }): React.JSX.Element {
  return (
    <div className={classNames.loading} style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div className={classNames.loadingContent}>
        {loadingIcon}
        Loading whiteboard...
      </div>
    </div>
  );
}

function WhiteboardLoadError({ className, error }: { className: string; error: string }): React.JSX.Element {
  return (
    <div className={className} style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div>{error}</div>
    </div>
  );
}

function WhiteboardScene({
  canDraw,
  collab,
  excalidraw,
  initialData,
  onApiReady,
  onChange,
  onPointerUpdate,
  theme,
  uiOptions,
}: {
  canDraw: boolean;
  collab: boolean;
  excalidraw: ExcalidrawModule;
  initialData: { appState: { currentItemStrokeColor: string; theme: "light" | "dark"; viewBackgroundColor: string } };
  onApiReady: (api: ExcalidrawImperativeAPI) => void;
  onChange: (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => void;
  onPointerUpdate: (payload: { pointer: { x: number; y: number } }) => void;
  theme: "light" | "dark";
  uiOptions: {
    canvasActions: { changeViewBackgroundColor: boolean; clearCanvas: boolean; export: false; loadScene: boolean; saveAsImage: boolean; saveToActiveFile: boolean; toggleTheme: boolean };
    tools: { image: boolean };
    welcomeScreen: boolean;
  };
}): React.JSX.Element {
  return <excalidraw.Excalidraw excalidrawAPI={onApiReady} initialData={initialData} isCollaborating={collab} name="Chalk whiteboard" onChange={onChange} onPointerUpdate={onPointerUpdate} renderTopRightUI={() => null} theme={theme} UIOptions={uiOptions} viewModeEnabled={!canDraw} />;
}

function WhiteboardCanvasBase(props: WhiteboardCanvasProps): React.JSX.Element {
  return <WhiteboardCanvasView state={useWhiteboardCanvasState(props)} />;
}

export const WhiteboardCanvas = memo(WhiteboardCanvasBase);
WhiteboardCanvas.displayName = "WhiteboardCanvas";
