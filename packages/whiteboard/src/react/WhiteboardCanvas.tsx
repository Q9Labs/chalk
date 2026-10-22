import { memo, useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject, type ReactNode } from "react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";

import type { ExcalidrawCollabEngine, ExcalidrawCollabEngineOptions } from "../collab/engine";
import type { AppState, BinaryFiles } from "../collab/types";
import { MathEditor } from "./MathEditor";
import { appendOrReplaceMathElement, createMathImageAsset, getChalkMathData, getSelectedMathElement } from "./math-elements";
import { renderLatexToSvg } from "./mathjax-renderer";

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

/** What a host that draws its own controls needs from the loaded engine. */
export interface WhiteboardEngineHandle {
  api: ExcalidrawImperativeAPI;
  excalidraw: ExcalidrawModule;
  /** Clears the shared board; resolves once the new empty scene is committed. */
  clear: () => Promise<void>;
  /** Clears and returns a restore bound to that committed scene and this engine lifetime. */
  clearWithUndo: () => Promise<() => boolean>;
  /** Renders LaTeX and places it on the board, or replaces the selected formula. */
  placeMath: (latex: string) => Promise<void>;
}

export interface WhiteboardCanvasProps {
  className?: string;
  /** Hides every engine control; the host draws its own and drives the engine through `onEngineReady`. */
  headless?: boolean;
  /** The colour this viewer sees for Ink. Ink travels as one canonical colour. */
  inkColor?: string;
  onEngineReady?: (engine: WhiteboardEngineHandle) => void;
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
  headless: boolean;
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
  inkColorRef: MutableRefObject<string | undefined>;
  collabOptionsRef: MutableRefObject<WhiteboardCollaborationOptions | undefined>;
  enginePromiseRef: MutableRefObject<Promise<void> | null>;
  engineRef: MutableRefObject<ExcalidrawCollabEngine | null>;
  isMountedRef: MutableRefObject<boolean>;
}

interface WhiteboardCollaboration {
  ready: boolean;
  apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>;
  engineRef: MutableRefObject<ExcalidrawCollabEngine | null>;
  handleApiReady: (api: ExcalidrawImperativeAPI) => void;
  handleChange: (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => void;
  handlePointerUpdate: (payload: { pointer: { x: number; y: number } }) => void;
  syncScene: () => void;
}

interface WhiteboardMath {
  initialLatex: string;
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
    headless: props.headless === true,
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

const STYLESHEET_ID = "chalk-excalidraw-styles";

/** Starts loading the board's stylesheet before anyone opens the board, so the board opens without waiting for it. */
export function preloadWhiteboardStylesheet(href: string = DEFAULT_EXCALIDRAW_CSS): void {
  if (typeof document !== "undefined") boardStylesheet(href);
}

function boardStylesheet(href: string): Element {
  const existing = document.getElementById(STYLESHEET_ID) ?? document.querySelector('link[href*="excalidraw"], style[data-href*="excalidraw"]');
  if (existing) return existing;
  const link = document.createElement("link");
  link.id = STYLESHEET_ID;
  link.rel = "stylesheet";
  link.href = href;
  // A link can finish before the board mounts, so it records its own outcome.
  link.addEventListener("load", () => (link.dataset.state = "loaded"));
  link.addEventListener("error", () => (link.dataset.state = "failed"));
  document.head.appendChild(link);
  return link;
}

function isManagedStylesheet(element: Element): element is HTMLLinkElement {
  return element instanceof HTMLLinkElement && element.id === STYLESHEET_ID;
}

function useExternalStylesheet(href: string): ExternalStylesheetState {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const element = boardStylesheet(href);
    const fail = () => setError(`Failed to load ${href}`);
    const ownLink = isManagedStylesheet(element);
    if (!ownLink || element.dataset.state === "loaded") {
      setLoaded(true);
      return;
    }
    if (element.dataset.state === "failed") {
      fail();
      return;
    }

    const load = () => setLoaded(true);
    element.addEventListener("load", load);
    element.addEventListener("error", fail);
    return () => {
      element.removeEventListener("load", load);
      element.removeEventListener("error", fail);
    };
  }, [href]);

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

// A headless board is transparent so its host paints the surface behind it.
const TRANSPARENT = "transparent";

function useWhiteboardInitialData(theme: "light" | "dark", headless: boolean, localParticipantColor?: string, inkColor?: string) {
  const initialInk = useRef(inkColor);
  return useMemo(
    () => ({
      appState: {
        viewBackgroundColor: headless ? TRANSPARENT : theme === "dark" ? "#000000" : "#ffffff",
        currentItemStrokeColor: (headless ? initialInk.current : localParticipantColor) ?? "#4CB9FF",
        theme,
      },
    }),
    [headless, localParticipantColor, theme],
  );
}

const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false as const,
    loadScene: false,
    saveAsImage: false,
    saveToActiveFile: false,
    toggleTheme: false,
  },
  tools: { image: false },
  welcomeScreen: false,
};

function useWhiteboardCollaboration(options: {
  canDraw: boolean;
  headless: boolean;
  inkColor?: string;
  collab?: WhiteboardCollaborationOptions;
  onExcalidrawApiReady?: (api: ExcalidrawImperativeAPI) => void;
  onLoadError?: (error: Error) => void;
  onSelectedLatexChange: (latex: string | null) => void;
  setLoadError: (message: string) => void;
}): WhiteboardCollaboration {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const refs = useCollaborationRefs(options.collab, options.canDraw, options.inkColor);
  const [engineReady, setEngineReady] = useState(false);
  const initializeEngine = useCollaborationEngineLoader(refs, apiRef, options.headless, options.onLoadError, options.setLoadError, setEngineReady);
  const handleApiReady = useExcalidrawApiReady(apiRef, initializeEngine, options.onExcalidrawApiReady);
  const handlers = useExcalidrawSceneHandlers(apiRef, refs.engineRef, options.onSelectedLatexChange);

  useCollaborationPermissions(refs.engineRef, options.canDraw, options.collab?.canManage);
  useCollaborationInk(refs.engineRef, options.inkColor);
  useCollaborationDisposal(refs.engineRef, refs.isMountedRef);
  useCollaborationInitialization(options.collab, apiRef, refs.engineRef, initializeEngine);

  return { ready: !options.collab || engineReady, apiRef, engineRef: refs.engineRef, handleApiReady, ...handlers };
}

function useCollaborationRefs(collab: WhiteboardCollaborationOptions | undefined, canDraw: boolean, inkColor: string | undefined): CollaborationRefs {
  const canDrawRef = useRef(canDraw);
  const inkColorRef = useRef(inkColor);
  const collabOptionsRef = useRef(collab);
  const enginePromiseRef = useRef<Promise<void> | null>(null);
  const engineRef = useRef<ExcalidrawCollabEngine | null>(null);
  const isMountedRef = useRef(true);

  canDrawRef.current = canDraw;
  inkColorRef.current = inkColor;
  collabOptionsRef.current = collab;

  return useMemo(() => ({ canDrawRef, inkColorRef, collabOptionsRef, enginePromiseRef, engineRef, isMountedRef }), [canDrawRef, inkColorRef, collabOptionsRef, enginePromiseRef, engineRef, isMountedRef]);
}

function useCollaborationEngineLoader(refs: CollaborationRefs, apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>, headless: boolean, onLoadError: ((error: Error) => void) | undefined, setLoadError: (message: string) => void, setEngineReady: (ready: boolean) => void) {
  return useCallback(() => {
    if (!refs.collabOptionsRef.current || refs.engineRef.current || refs.enginePromiseRef.current) return;

    refs.enginePromiseRef.current = import("../collab/engine")
      .then(({ ExcalidrawCollabEngine }) => {
        const api = apiRef.current;
        const collab = refs.collabOptionsRef.current;
        if (!refs.isMountedRef.current || !api || !collab) return;

        refs.engineRef.current = new ExcalidrawCollabEngine({
          excalidrawAPI: api,
          canDraw: refs.canDrawRef.current,
          canManage: collab.canManage,
          renderCursors: !headless,
          ...(refs.inkColorRef.current ? { inkColor: refs.inkColorRef.current } : {}),
          submitUpdate: collab.submitUpdate,
          sendCursor: collab.sendCursor,
          requestSnapshot: collab.requestSnapshot,
          clear: collab.clear,
          fileTransfer: collab.fileTransfer,
          presignDownload: collab.presignDownload,
          subscribe: collab.subscribe,
          onFileSyncStateChange: collab.onFileSyncStateChange,
          onSubmissionError: collab.onSubmissionError,
        });
        setEngineReady(true);
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
  }, [apiRef, headless, onLoadError, refs, setLoadError, setEngineReady]);
}

function useExcalidrawApiReady(apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>, initializeEngine: () => void, onExcalidrawApiReady: ((api: ExcalidrawImperativeAPI) => void) | undefined) {
  const didReportApiRef = useRef(false);

  return useCallback(
    (api: ExcalidrawImperativeAPI) => {
      apiRef.current = api;
      initializeEngine();

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

function useCollaborationPermissions(engineRef: MutableRefObject<ExcalidrawCollabEngine | null>, canDraw: boolean, canManage: boolean | undefined) {
  useEffect(() => {
    engineRef.current?.setCanDraw(canDraw);
    engineRef.current?.setCanManage(canManage);
  }, [canDraw, canManage, engineRef]);
}

function useCollaborationInk(engineRef: MutableRefObject<ExcalidrawCollabEngine | null>, inkColor: string | undefined) {
  useEffect(() => {
    if (inkColor) engineRef.current?.setInkColor(inkColor);
  }, [engineRef, inkColor]);
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

function useCollaborationInitialization(collab: WhiteboardCollaborationOptions | undefined, apiRef: MutableRefObject<ExcalidrawImperativeAPI | null>, engineRef: MutableRefObject<ExcalidrawCollabEngine | null>, initializeEngine: () => void) {
  useEffect(() => {
    if (!collab) {
      engineRef.current?.dispose();
      engineRef.current = null;
      return;
    }

    if (apiRef.current) initializeEngine();
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

  return { closeMath, handleSubmitMath, initialLatex: selectedLatex ?? DEFAULT_LATEX, isMathOpen, openMath, selectedLatex };
}

function useWhiteboardCanvasState(props: WhiteboardCanvasProps) {
  const configuration = useWhiteboardCanvasConfiguration(props);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedLatex, setSelectedLatex] = useState<string | null>(null);
  const excalidraw = useExcalidrawModule(props.onLoadError, setLoadError);
  const stylesheet = useExternalStylesheet(configuration.excalidrawCssPath);
  const collaboration = useWhiteboardCollaboration({
    canDraw: configuration.canDraw,
    headless: configuration.headless,
    inkColor: props.inkColor,
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
  const initialData = useWhiteboardInitialData(configuration.theme, configuration.headless, props.localParticipantColor, props.inkColor);
  const resolvedLoadError = loadError ?? stylesheet.error;
  const isReady = Boolean(excalidraw && stylesheet.loaded && !resolvedLoadError);
  const engine = useEngineHandle(props.onEngineReady, excalidraw, collaboration, math.handleSubmitMath, configuration.headless, isReady);

  return {
    collaboration,
    configuration,
    excalidraw,
    initialData,
    isReady,
    math,
    resolvedLoadError,
    uiOptions: UI_OPTIONS,
    ...engine,
  };
}

function useEngineHandle(onEngineReady: ((engine: WhiteboardEngineHandle) => void) | undefined, excalidraw: ExcalidrawModule | null, collaboration: WhiteboardCollaboration, placeMath: (latex: string) => Promise<void>, headless: boolean, isReady: boolean) {
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);
  // Excalidraw hands over its API before it loads initialData, and that load resets the tool and view.
  const [loaded, setLoaded] = useState(false);
  const { handleApiReady, handleChange } = collaboration;
  const onApiReady = useCallback(
    (next: ExcalidrawImperativeAPI) => {
      handleApiReady(next);
      setApi(next);
    },
    [handleApiReady],
  );
  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      handleChange(elements, appState, files);
      if (!appState.isLoading) setLoaded(true);
      // A shared background from an older board must not cover the surface its host paints.
      if (headless && appState.viewBackgroundColor !== TRANSPARENT) api?.updateScene({ appState: { viewBackgroundColor: TRANSPARENT } });
    },
    [api, handleChange, headless],
  );
  const placeMathRef = useRef(placeMath);
  placeMathRef.current = placeMath;
  const { engineRef } = collaboration;
  useEffect(() => {
    if (!api || !excalidraw || !loaded || !isReady || !collaboration.ready || !onEngineReady) return;
    let active = true;
    onEngineReady({
      api,
      excalidraw,
      clear: async () => {
        const engine = engineRef.current;
        if (engine) await engine.clear();
        else {
          api.updateScene({ elements: [], captureUpdate: excalidraw.CaptureUpdateAction.NEVER });
          api.history.clear();
        }
      },
      clearWithUndo: async () => {
        const engine = engineRef.current;
        if (engine) return engine.clearWithUndo();
        const before = api.getSceneElements();
        api.updateScene({ elements: [], captureUpdate: excalidraw.CaptureUpdateAction.NEVER });
        api.history.clear();
        return () => {
          if (!active || api.getSceneElementsIncludingDeleted().length > 0) return false;
          api.updateScene({ elements: before.map((element) => excalidraw.newElementWith(element, {})), captureUpdate: excalidraw.CaptureUpdateAction.IMMEDIATELY });
          return true;
        };
      },
      placeMath: (latex) => placeMathRef.current(latex),
    });
    return () => {
      active = false;
    };
  }, [api, engineRef, excalidraw, isReady, loaded, collaboration.ready, onEngineReady]);
  return { onApiReady, onChange };
}

function WhiteboardCanvasView({ state }: { state: ReturnType<typeof useWhiteboardCanvasState> }): React.JSX.Element {
  const { configuration, excalidraw, initialData, isReady, math, onApiReady, onChange, collaboration, resolvedLoadError, uiOptions } = state;

  return (
    <div className={configuration.rootClassName} hidden={!configuration.isVisible}>
      <WhiteboardMathToolbar canDraw={configuration.canDraw && !configuration.isCollaborating && !configuration.headless} classNames={configuration.classNames} isReady={isReady} onOpenMath={math.openMath} selectedLatex={math.selectedLatex} />
      {/* A headless host draws its own loading state; a load error still shows. */}
      <WhiteboardCanvasStatus classNames={configuration.classNames} error={resolvedLoadError} icons={configuration.icons} isReady={isReady || configuration.headless} />
      {excalidraw && (
        <WhiteboardScene canDraw={configuration.canDraw} collab={configuration.isCollaborating} excalidraw={excalidraw} initialData={initialData} onApiReady={onApiReady} onChange={onChange} onPointerUpdate={collaboration.handlePointerUpdate} theme={configuration.theme} uiOptions={uiOptions} />
      )}
      {math.isMathOpen && <MathEditor initialLatex={math.initialLatex} isEditing={Boolean(math.selectedLatex)} classNames={configuration.classNames} icons={configuration.icons} onClose={math.closeMath} onSubmit={math.handleSubmitMath} />}
    </div>
  );
}

function WhiteboardMathToolbar({ canDraw, classNames, isReady, onOpenMath, selectedLatex }: { canDraw: boolean; classNames: WhiteboardCanvasClassNames; isReady: boolean; onOpenMath: () => void; selectedLatex: string | null }): React.JSX.Element | null {
  if (!isReady || !canDraw) return null;
  const label = selectedLatex ? "Edit math equation" : "Insert math equation";

  return (
    <div className={classNames.toolbar} style={{ position: "absolute", top: 12, left: 12, zIndex: 20, display: "flex" }}>
      <button type="button" onClick={onOpenMath} disabled={!canDraw} className={classNames.toolbarButton} aria-label={label} title={label}>
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
    <div role="alert" className={className} style={{ position: "absolute", inset: 0, zIndex: 30, display: "flex", alignItems: "center", justifyContent: "center" }}>
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
