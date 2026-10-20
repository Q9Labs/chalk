import type { ChalkWhiteboardView } from "@q9labsai/chalk-client";
import { WhiteboardCanvas, type WhiteboardEngineHandle } from "@q9labsai/chalk-whiteboard/react";
import { useCallback, useEffect, useMemo, useRef, useState, type MutableRefObject } from "react";
import { useCan, useConnection } from "../../bindings/hooks";
import { useMediaQuery, usePrefersReducedMotion } from "../../internal/useMediaQuery";
import type { Participant } from "../participant-grid/ParticipantGrid";
import type { WhiteboardViewProps } from "../whiteboard-view/WhiteboardView";
import { applyTool, boardImage, clearWithUndo, hasContent, placeNote, pressHistory, readCamera, restyleSelection, sceneSignature, setCamera, settleNoteText, type PenChoice } from "./board-engine";
import {
  ISLAND_PLACES,
  SURFACES,
  TOOL_KEYS,
  cameraForView,
  clampZoom,
  mixCamera,
  personColor,
  readStored,
  sameCamera,
  selectionColor,
  surfaceFill,
  surfaceInk,
  visibleView,
  writeStored,
  zoomAroundCentre,
  type BoardSurface,
  type BoardTool,
  type CallTheme,
  type Camera,
  type IslandPlace,
  type PenColor,
  type PenWidth,
  type ShapeTool,
  type Viewport,
} from "./board-model";
import { BoardCursors, type RemoteCursor } from "./BoardCursors";
import { BoardIcon } from "./BoardIcon";
import { BoardIsland } from "./BoardIsland";
import { BoardMenu } from "./BoardMenu";
import { BoardStyles } from "./BoardStyles";
import { useBoardToast, type BoardToast } from "./board-toasts";

export type BoardProps = {
  readonly board: WhiteboardViewProps;
  /** False for the Grid tile: the live drawing with no controls. */
  readonly primary: boolean;
  readonly visible: boolean;
  readonly colorScheme: CallTheme;
  readonly people: readonly Participant[];
  readonly following: string | null;
  readonly onFollow: (participantId: string | null) => void;
  /** Absent, or answering false, when the board service does not share views. */
  readonly sendView?: (view: ChalkWhiteboardView) => boolean;
  readonly onViewsUnavailable?: () => void;
  readonly onClose?: () => void;
};

const SURFACE_KEY = "chalk.board.surface";
const ISLAND_KEY = "chalk.board.island";
const COMPACT_BELOW_PX = 1060;
const VIEW_SEND_MS = 150;
const VIEW_HEARTBEAT_MS = 2000;
const GLIDE_MS = 300;
const ZOOM_STEP = 1.25;
const EDITING_KEYS = new Set(["delete", "backspace", "arrowup", "arrowdown", "arrowleft", "arrowright", "escape", " ", "enter", "shift", "alt", "control", "meta", "tab"]);
const MODIFIED_ENGINE_KEYS = new Set(["c", "v", "x", "a", "d", "=", "+", "-", "0"]);

const first = (name: string) => name.split(" ")[0] ?? name;

function fitContent(engine: WhiteboardEngineHandle, animate: boolean) {
  engine.api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.85, animate });
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT");
}

/** Counts this person's own changes, because the engine does not say whether it can undo. */
function useHistoryCounts() {
  const [depth, setDepth] = useState({ undo: 0, redo: 0 });
  return {
    canUndo: depth.undo > 0,
    canRedo: depth.redo > 0,
    changed: useCallback(() => setDepth((current) => ({ undo: current.undo + 1, redo: 0 })), []),
    undone: useCallback(() => setDepth((current) => (current.undo > 0 ? { undo: current.undo - 1, redo: current.redo + 1 } : current)), []),
    redone: useCallback(() => setDepth((current) => (current.redo > 0 ? { undo: current.undo + 1, redo: current.redo - 1 } : current)), []),
  };
}

type CameraControl = {
  readonly cameraRef: MutableRefObject<Camera>;
  readonly viewportRef: MutableRefObject<Viewport>;
  readonly zoom: number;
  readonly move: (target: Camera, animate: boolean) => void;
};

/** Owns the camera: glides to a new view, and tells a move by hand from one the board made. */
function useCamera(engine: WhiteboardEngineHandle | null, root: MutableRefObject<HTMLDivElement | null>, onManualMove: () => void, onMoved: () => void): CameraControl {
  const cameraRef = useRef<Camera>({ scrollX: 0, scrollY: 0, zoom: 1 });
  const viewportRef = useRef<Viewport>({ width: 1, height: 1 });
  const expected = useRef<Camera | null>(null);
  const glide = useRef(0);
  const [zoom, setZoom] = useState(1);
  const reduced = usePrefersReducedMotion();
  const manual = useRef(onManualMove);
  manual.current = onManualMove;
  const moved = useRef(onMoved);
  moved.current = onMoved;

  useEffect(() => {
    if (!engine) return;
    const paint = (camera: Camera) => {
      cameraRef.current = camera;
      const element = root.current;
      if (element) {
        // The dot grid moves with the board: a background offset, the board's one paint-only update.
        let gap = 24 * camera.zoom;
        while (gap < 14) gap *= 2;
        element.style.setProperty("--board-dot-gap", `${gap}px`);
        element.style.setProperty("--board-dot-x", `${(camera.scrollX * camera.zoom) % gap}px`);
        element.style.setProperty("--board-dot-y", `${(camera.scrollY * camera.zoom) % gap}px`);
      }
      setZoom(camera.zoom);
    };
    paint(readCamera(engine));
    return engine.api.onScrollChange((scrollX, scrollY, next) => {
      const camera = { scrollX, scrollY, zoom: next.value };
      if (camera.zoom !== clampZoom(camera.zoom)) {
        expected.current = { ...camera, zoom: clampZoom(camera.zoom) };
        setCamera(engine, expected.current);
        return;
      }
      paint(camera);
      if (expected.current && sameCamera(camera, expected.current)) return;
      expected.current = null;
      cancelAnimationFrame(glide.current);
      manual.current();
      moved.current();
    });
  }, [engine, root]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    viewportRef.current = { width: element.clientWidth || 1, height: element.clientHeight || 1 };
    const observer = new ResizeObserver(([entry]) => {
      if (entry) viewportRef.current = { width: entry.contentRect.width, height: entry.contentRect.height };
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => () => cancelAnimationFrame(glide.current), []);

  const move = useCallback(
    (target: Camera, animate: boolean) => {
      if (!engine) return;
      cancelAnimationFrame(glide.current);
      const set = (camera: Camera) => {
        expected.current = camera;
        setCamera(engine, camera);
      };
      if (!animate || reduced) {
        set(target);
        moved.current();
        return;
      }
      const from = cameraRef.current;
      const started = performance.now();
      const step = (now: number) => {
        const progress = Math.min(1, (now - started) / GLIDE_MS);
        set(mixCamera(from, target, 1 - (1 - progress) ** 3));
        if (progress < 1) glide.current = requestAnimationFrame(step);
        else moved.current();
      };
      glide.current = requestAnimationFrame(step);
    },
    [engine, reduced],
  );

  return useMemo(() => ({ cameraRef, viewportRef, zoom, move }), [move, zoom]);
}

/** Engine keys the board does not offer never reach the engine: no help, library, menus or theme switch. */
function useBoardKeys(root: MutableRefObject<HTMLDivElement | null>, handlers: { readonly onTool: (tool: BoardTool) => void; readonly onZoom: (factor: number) => void; readonly onUndo: () => void; readonly onRedo: () => void; readonly canDraw: boolean }) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const keydown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      const modified = event.metaKey || event.ctrlKey;
      const { onTool, onZoom, onUndo, onRedo, canDraw } = latest.current;
      if (modified && !event.altKey && key === "z") return event.shiftKey ? onRedo() : onUndo();
      if (modified && !event.altKey && key === "y") return onRedo();
      if (modified && !event.altKey && !event.shiftKey && MODIFIED_ENGINE_KEYS.has(key)) return;
      if (!modified && !event.altKey) {
        const tool = TOOL_KEYS[key];
        if (tool && canDraw) {
          event.preventDefault();
          event.stopPropagation();
          onTool(tool);
          return;
        }
        if (key === "+" || key === "=" || key === "-") {
          event.preventDefault();
          event.stopPropagation();
          onZoom(key === "-" ? 1 / ZOOM_STEP : ZOOM_STEP);
          return;
        }
        if (EDITING_KEYS.has(key)) return;
      }
      event.stopPropagation();
    };
    const blockMenu = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
    };
    element.addEventListener("keydown", keydown, true);
    element.addEventListener("contextmenu", blockMenu, true);
    return () => {
      element.removeEventListener("keydown", keydown, true);
      element.removeEventListener("contextmenu", blockMenu, true);
    };
  }, [root]);
}

/** Images need a board file upload that the service does not offer yet, so the board refuses them plainly. */
function useImageRefusal(root: MutableRefObject<HTMLDivElement | null>, toast: (toast: BoardToast) => void) {
  const latest = useRef(toast);
  latest.current = toast;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const refuse = (files: FileList | undefined | null, event: Event) => {
      if (!files || ![...files].some((file) => file.type.startsWith("image/"))) return;
      event.preventDefault();
      event.stopPropagation();
      latest.current({ type: "error", message: "The board can't take images yet.", duration: 5000 });
    };
    const paste = (event: ClipboardEvent) => refuse(event.clipboardData?.files, event);
    const drop = (event: DragEvent) => refuse(event.dataTransfer?.files, event);
    element.addEventListener("paste", paste, true);
    element.addEventListener("drop", drop, true);
    return () => {
      element.removeEventListener("paste", paste, true);
      element.removeEventListener("drop", drop, true);
    };
  }, [root]);
}

/**
 * Chalk's board: Excalidraw draws, and every control around it is the call's own. Each person picks their own
 * surface and island place; the drawing, the cursors and the views are shared.
 */
export function Board({ board, primary, visible, colorScheme, people, following, onFollow, sendView, onViewsUnavailable, onClose }: BoardProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const toast = useBoardToast();
  const isHost = useCan("manageWhiteboard");
  const connection = useConnection();
  const offline = connection.status === "reconnecting";
  const phone = useMediaQuery("(max-width: 640px)");
  const [engine, setEngine] = useState<WhiteboardEngineHandle | null>(null);
  const [surface, setSurface] = useState<BoardSurface>(() => readStored(SURFACE_KEY, SURFACES, "chalkboard"));
  const [place, setPlace] = useState<IslandPlace>(() => readStored(ISLAND_KEY, ISLAND_PLACES, "bottom"));
  const [tool, setTool] = useState<BoardTool>("pen");
  const [shape, setShape] = useState<ShapeTool>("rectangle");
  const [color, setColor] = useState<PenColor>("ink");
  const [width, setWidth] = useState<PenWidth>("medium");
  const [empty, setEmpty] = useState(true);
  const [narrow, setNarrow] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const canDraw = primary && (board.collab?.canDraw ?? board.canDraw ?? true);
  const compact = phone || narrow;
  const history = useHistoryCounts();
  const views = useRef(new Map<string, ChalkWhiteboardView>());
  const cursors = useRef(new Map<string, RemoteCursor>());
  const pen: PenChoice = useMemo(() => ({ color, width, surface, theme: colorScheme }), [color, width, surface, colorScheme]);
  const followingRef = useRef(following);
  followingRef.current = following;
  const nameOf = useCallback((id: string) => first(people.find((person) => person.id === id)?.displayName ?? "Someone"), [people]);
  const colorFor = useCallback(
    (id: string) =>
      personColor(
        Math.max(
          0,
          people.findIndex((person) => person.id === id),
        ),
      ),
    [people],
  );

  const stopFollowing = useCallback(() => {
    const current = followingRef.current;
    if (!current) return;
    onFollow(null);
    toast({ message: `Stopped following ${nameOf(current)}` });
  }, [nameOf, onFollow, toast]);

  const shareView = useRef<(bring: boolean) => void>(() => undefined);
  const camera = useCamera(engine, root, stopFollowing, () => shareView.current(false));

  // My own view, shortly after it changes and every two seconds, so others can follow me at once.
  useEffect(() => {
    if (!primary || !sendView || !engine) return;
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    const send = (bring: boolean) => {
      last = performance.now();
      if (!sendView({ ...visibleView(camera.cameraRef.current, camera.viewportRef.current), bring })) onViewsUnavailable?.();
    };
    shareView.current = (bring) => {
      if (bring) return send(true);
      clearTimeout(pending);
      pending = setTimeout(() => send(false), Math.max(0, VIEW_SEND_MS - (performance.now() - last)));
    };
    const heartbeat = setInterval(() => send(false), VIEW_HEARTBEAT_MS);
    send(false);
    return () => {
      clearInterval(heartbeat);
      clearTimeout(pending);
      shareView.current = () => undefined;
    };
  }, [camera.cameraRef, camera.viewportRef, engine, onViewsUnavailable, primary, sendView]);

  const { move, viewportRef } = camera;
  const goTo = useCallback(
    (participantId: string, animate: boolean) => {
      const view = views.current.get(participantId);
      if (view) move(cameraForView(view, viewportRef.current), animate);
    },
    [move, viewportRef],
  );

  // Cursors and views arrive on the board's own event stream, next to the drawing.
  const subscribe = board.collab?.subscribe;
  const latestView = useRef<(event: ChalkWhiteboardView & { readonly participantId: string }) => void>(() => undefined);
  latestView.current = (event) => {
    views.current.set(event.participantId, event);
    if (event.bring && followingRef.current !== event.participantId) {
      onFollow(event.participantId);
      toast({ message: `${nameOf(event.participantId)} brought everyone to this view` });
      return;
    }
    if (followingRef.current === event.participantId) goTo(event.participantId, true);
  };
  useEffect(() => {
    if (!subscribe || !primary) return;
    return subscribe((event) => {
      if (event.type === "cursor") cursors.current.set(event.participantId, { participantId: event.participantId, displayName: event.displayName, x: event.x, y: event.y });
      else if (event.type === "view") latestView.current(event);
    });
  }, [primary, subscribe]);

  useEffect(() => {
    if (following) goTo(following, true);
  }, [following, goTo]);

  // The engine: tools, styles, history counts, emptiness and note text.
  useEffect(() => {
    if (engine && canDraw) applyTool(engine, tool, pen);
  }, [canDraw, engine, pen, tool]);

  useEffect(() => {
    if (!engine) return;
    let before = sceneSignature(engine);
    let wasEditing = false;
    setEmpty(!hasContent(engine));
    const offDown = engine.api.onPointerDown(() => (before = sceneSignature(engine)));
    const offUp = engine.api.onPointerUp(() => {
      if (sceneSignature(engine) !== before) history.changed();
    });
    // The first drawing to arrive is fitted into view once, as the mockup opens the board.
    let fitted = hasContent(engine);
    if (fitted && !followingRef.current) fitContent(engine, false);
    const offChange = engine.api.onChange((elements, appState) => {
      const nothing = elements.every((element) => element.isDeleted);
      setEmpty(nothing);
      if (!fitted && !nothing) {
        fitted = true;
        if (!followingRef.current) requestAnimationFrame(() => fitContent(engine, false));
      }
      const editing = appState.editingTextElement !== null;
      if (wasEditing && !editing) {
        settleNoteText(engine);
        history.changed();
      }
      wasEditing = editing;
    });
    return () => {
      offDown();
      offUp();
      offChange();
    };
  }, [engine, history.changed]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setNarrow((entry?.contentRect.width ?? COMPACT_BELOW_PX) < COMPACT_BELOW_PX));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const chooseTool = useCallback((next: BoardTool) => {
    if (next === "rectangle" || next === "ellipse" || next === "diamond" || next === "arrow" || next === "line") setShape(next);
    setTool(next);
  }, []);
  const undo = useCallback(() => {
    const container = root.current?.querySelector<HTMLElement>(".excalidraw");
    if (container) pressHistory(container, false);
    history.undone();
  }, [history]);
  const redo = useCallback(() => {
    const container = root.current?.querySelector<HTMLElement>(".excalidraw");
    if (container) pressHistory(container, true);
    history.redone();
  }, [history]);
  const zoomBy = useCallback(
    (factor: number) => {
      stopFollowing();
      camera.move(zoomAroundCentre(camera.cameraRef.current, camera.viewportRef.current, camera.cameraRef.current.zoom * factor), true);
    },
    [camera, stopFollowing],
  );
  useBoardKeys(root, { onTool: chooseTool, onZoom: zoomBy, onUndo: history.undone, onRedo: history.redone, canDraw });
  useImageRefusal(root, toast);

  const restyle = (next: { readonly color?: PenColor; readonly width?: PenWidth }) => {
    if (next.color) setColor(next.color);
    if (next.width) setWidth(next.width);
    if (engine) {
      restyleSelection(engine, tool, { ...pen, ...next });
      history.changed();
    }
  };
  const choosePlace = (next: IslandPlace, announce: boolean) => {
    setPlace(next);
    writeStored(ISLAND_KEY, next);
    if (announce) setAnnouncement(`Tool island moved to ${next}`);
  };
  const chooseSurface = (next: BoardSurface) => {
    setSurface(next);
    writeStored(SURFACE_KEY, next);
  };
  const fit = () => {
    stopFollowing();
    if (engine) fitContent(engine, true);
  };
  const download = async () => {
    if (!engine) return;
    try {
      const url = URL.createObjectURL(await boardImage(engine, surfaceFill(surface, colorScheme)));
      const link = document.createElement("a");
      link.href = url;
      link.download = "chalk-board.png";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast({ message: "Saved chalk-board.png" });
    } catch {
      toast({ type: "error", message: "Could not save the image. Try again." });
    }
  };
  const copy = async () => {
    if (!engine) return;
    try {
      const image = await boardImage(engine, surfaceFill(surface, colorScheme));
      await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
      toast({ message: "Copied the board as an image" });
    } catch {
      toast({ type: "error", message: "The browser blocked copying. Use Download as PNG instead." });
    }
  };
  const bring = () => {
    shareView.current(true);
    toast({ message: "Everyone is following your view" });
  };
  const clear = async () => {
    if (!engine) return;
    const restore = await clearWithUndo(engine);
    toast({ message: "Board cleared", action: { label: "Undo", onClick: () => void restore() } });
  };
  const placeNoteAt = (event: React.PointerEvent<HTMLDivElement>) => {
    const container = root.current?.querySelector<HTMLElement>(".excalidraw");
    if (!engine || !container || !root.current) return;
    const rect = root.current.getBoundingClientRect();
    const { scrollX, scrollY, zoom } = camera.cameraRef.current;
    placeNote(engine, container, { x: (event.clientX - rect.left) / zoom - scrollX, y: (event.clientY - rect.top) / zoom - scrollY }, color);
    history.changed();
    setTool("selection");
  };

  const ink = surfaceInk(surface, colorScheme);
  const followed = following ? nameOf(following) : null;
  const ready = engine !== null;
  return (
    <div ref={root} className="chalk-board" data-surface={surface} data-theme={colorScheme} data-ready={ready || undefined} data-compact={compact || undefined} data-primary={primary || undefined} style={{ ["--board-selection" as string]: selectionColor(surface, colorScheme) }} hidden={!visible}>
      <BoardStyles />
      <WhiteboardCanvas {...board} headless canDraw={canDraw} collab={board.collab ? { ...board.collab, canDraw } : undefined} inkColor={ink} theme="light" isVisible={visible} className="chalk-board-engine" onEngineReady={setEngine} />
      {!ready ? (
        <div className="chalk-board-loading" role="status">
          <span className="chalk-board-spinner" aria-hidden="true" />
          Opening board
        </div>
      ) : null}
      {primary && ready && empty ? <BoardHint canDraw={canDraw} /> : null}
      {primary && tool === "note" && canDraw ? <div className="chalk-board-note-layer" aria-hidden="true" onPointerDown={placeNoteAt} /> : null}
      {primary ? <BoardCursors cursorsRef={cursors} cameraRef={camera.cameraRef} colorFor={colorFor} hidden={offline} /> : null}
      {primary && ready ? (
        <>
          <div className="chalk-board-chips" data-low={(!compact && place === "top" && canDraw) || undefined}>
            {followed ? (
              <div className="chalk-board-chip" role="status">
                <BoardIcon name="eye" size={16} />
                Following {followed}
                <button type="button" className="chalk-board-chip-button" onClick={stopFollowing}>
                  Stop
                </button>
              </div>
            ) : null}
            {offline ? (
              <div className="chalk-board-chip" data-quiet role="status">
                <BoardIcon name="wifiOff" size={16} />
                Offline. Your drawing will sync.
              </div>
            ) : null}
          </div>
          {!canDraw ? (
            <div className="chalk-board-view-only">
              <BoardIcon name="lock" size={14} />
              View only
            </div>
          ) : null}
          <div className="chalk-board-corner">
            <BoardMenu
              surface={surface}
              onSurface={chooseSurface}
              place={!compact && canDraw ? place : undefined}
              onPlace={(next) => choosePlace(next, true)}
              onDownload={() => void download()}
              onCopy={() => void copy()}
              onBring={isHost && sendView ? bring : undefined}
              onClear={isHost && canDraw ? () => void clear() : undefined}
              onClose={onClose}
            />
          </div>
          <div className="chalk-board-zoom" role="group" aria-label="Zoom">
            <button type="button" aria-label="Zoom out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
              <BoardIcon name="minus" size={16} />
            </button>
            <button type="button" aria-label={`Zoom ${Math.round(camera.zoom * 100)}%, reset to 100%`} className="chalk-board-zoom-value" onClick={() => zoomBy(1 / camera.cameraRef.current.zoom)}>
              {Math.round(camera.zoom * 100)}%
            </button>
            <button type="button" aria-label="Zoom in" onClick={() => zoomBy(ZOOM_STEP)}>
              <BoardIcon name="plus" size={16} />
            </button>
            <span className="chalk-board-zoom-rule" aria-hidden="true" />
            <button type="button" aria-label="Fit to content" onClick={fit}>
              <BoardIcon name="fit" size={16} />
            </button>
          </div>
          {canDraw ? (
            <BoardIsland
              tool={tool}
              shape={shape}
              onTool={chooseTool}
              color={color}
              width={width}
              onColor={(next) => restyle({ color: next })}
              onWidth={(next) => restyle({ width: next })}
              surface={surface}
              theme={colorScheme}
              canUndo={history.canUndo}
              canRedo={history.canRedo}
              onUndo={undo}
              onRedo={redo}
              place={place}
              onPlace={choosePlace}
              compact={compact}
            />
          ) : null}
          <div className="chalk-board-announcer" aria-live="polite">
            {announcement}
          </div>
        </>
      ) : null}
    </div>
  );
}

function BoardHint({ canDraw }: { readonly canDraw: boolean }) {
  if (!canDraw)
    return (
      <div className="chalk-board-hint">
        <p>Nothing here yet. When someone draws, it shows up here.</p>
      </div>
    );
  return (
    <div className="chalk-board-hint">
      <p>An empty board. Draw, type or add a sticky note.</p>
      <ul>
        <li>
          <kbd>P</kbd> Pen
        </li>
        <li>
          <kbd>T</kbd> Text
        </li>
        <li>
          <kbd>N</kbd> Sticky note
        </li>
      </ul>
    </div>
  );
}
