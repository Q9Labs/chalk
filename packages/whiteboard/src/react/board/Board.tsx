import type { WhiteboardView as ChalkWhiteboardView } from "../../collab/view";
import { useEngineHistory } from "./board-history";
import { ViewVersions } from "./board-view-versions";
import { WhiteboardCanvas, type WhiteboardEngineHandle } from "../WhiteboardCanvas";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MutableRefObject } from "react";
import { useMediaQuery, usePrefersReducedMotion } from "./useMediaQuery";
import type { WhiteboardCanvasProps } from "../WhiteboardCanvas";
import type { WhiteboardViewBounds } from "../../collab/view";
import type { ReactNode } from "react";
import { applyTool, boardImage, placeNote, pressHistory, readCamera, restyleSelection, sceneSignature, setCamera, settleNoteText, type PenChoice } from "./board-engine";
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
import { BoardCursors, rememberCursor, type RemoteCursor } from "./BoardCursors";
import { BoardIcon } from "./BoardIcon";
import { BoardIsland } from "./BoardIsland";
import { BoardMenu } from "./BoardMenu";
import type { WhoCanDraw } from "./board-draw-policy";
import { WHITEBOARD_VIEW_PEOPLE_MAX } from "../../collab/view-limits";
import { BoardStyles } from "./BoardStyles";
import { useBoardToast, type BoardToast } from "./board-toasts";

export type BoardProps = {
  readonly board: Omit<WhiteboardCanvasProps, "classNames" | "icons">;
  readonly isHost: boolean;
  readonly connectionStatus: string;
  readonly sceneId: string | null;
  readonly sceneStatus: string;
  readonly ownParticipantId: string | null;
  readonly viewBounds: WhiteboardViewBounds;
  readonly participantIds?: readonly string[];
  readonly whoCanDraw?: WhoCanDraw;
  readonly renderCursorAvatar?: (name: string) => ReactNode;
  readonly onExport?: (image: Blob, action: "download" | "copy") => Promise<void>;
  /** False for the Grid tile: the live drawing with no controls. */
  readonly primary: boolean;
  readonly visible: boolean;
  readonly phone?: boolean;
  readonly landscapeControlsVisible?: boolean;
  readonly presentation?: "web" | "mobile";
  readonly colorScheme: CallTheme;
  readonly people: readonly { readonly id: string; readonly displayName: string }[];
  readonly following: string | null;
  readonly onFollow: (participantId: string | null) => void;
  /** Absent, or answering false, when the board service does not share views. */
  readonly sendView?: (view: ChalkWhiteboardView) => boolean | Promise<boolean>;
  readonly downloadLabel?: string;
  readonly onClose?: () => void;
};

const SURFACE_KEY = "chalk.board.surface";
const ISLAND_KEY = "chalk.board.island";
const COMPACT_BELOW_PX = 1060;
const VIEW_SEND_MS = 150;
const VIEW_HEARTBEAT_MS = 2000;
const GLIDE_MS = 300;
const ZOOM_STEP = 1.25;
const NOTE_FONT_PX = 18;
const EDITING_KEYS = new Set(["delete", "backspace", "arrowup", "arrowdown", "arrowleft", "arrowright", "escape", " ", "enter", "shift", "alt", "control", "meta", "tab"]);
const MODIFIED_ENGINE_KEYS = new Set(["c", "v", "x", "a", "d", "=", "+", "-", "0"]);

const first = (name: string) => name.split(" ")[0] ?? name;

function fitContent(engine: WhiteboardEngineHandle, animate: boolean) {
  engine.api.scrollToContent(undefined, { fitToViewport: true, viewportZoomFactor: 0.85, maxZoom: 1, animate });
}

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.tagName === "TEXTAREA" || target.tagName === "INPUT");
}

type CameraControl = {
  readonly cameraRef: MutableRefObject<Camera>;
  readonly viewportRef: MutableRefObject<Viewport>;
  readonly zoom: number;
  readonly move: (target: Camera, animate: boolean, source?: "follow") => void;
  readonly fit: () => void;
};

/** Camera motion leads by default; only applying a followed view preserves its origin. */
function useCamera(engine: WhiteboardEngineHandle | null, root: MutableRefObject<HTMLDivElement | null>, onLeadingMove: () => void, onMoved: () => void, onViewportReady: () => void): CameraControl {
  const cameraRef = useRef<Camera>({ scrollX: 0, scrollY: 0, zoom: 1 });
  const viewportRef = useRef<Viewport>({ width: 1, height: 1 });
  const expected = useRef<Camera | null>(null);
  const glide = useRef(0);
  const [zoom, setZoom] = useState(1);
  const reduced = usePrefersReducedMotion();
  const leading = useRef(onLeadingMove);
  leading.current = onLeadingMove;
  const moved = useRef(onMoved);
  moved.current = onMoved;
  const resized = useRef(onViewportReady);
  resized.current = onViewportReady;

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
        leading.current();
        expected.current = { ...camera, zoom: clampZoom(camera.zoom) };
        setCamera(engine, expected.current);
        return;
      }
      paint(camera);
      if (expected.current && sameCamera(camera, expected.current)) return;
      expected.current = null;
      cancelAnimationFrame(glide.current);
      leading.current();
      moved.current();
    });
  }, [engine, root]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    viewportRef.current = { width: element.clientWidth || 1, height: element.clientHeight || 1 };
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return;
      viewportRef.current = { width: entry.contentRect.width, height: entry.contentRect.height };
      if (entry.contentRect.width > 0 && entry.contentRect.height > 0) resized.current();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);

  useEffect(() => () => cancelAnimationFrame(glide.current), []);

  const move = useCallback(
    (target: Camera, animate: boolean, source?: "follow") => {
      if (!engine) return;
      if (source !== "follow") leading.current();
      cancelAnimationFrame(glide.current);
      if (sameCamera(target, cameraRef.current)) {
        expected.current = target;
        // Refresh relay metadata without a camera write, even after an out-and-back update.
        moved.current();
        return;
      }
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
        const progress = Math.max(0, Math.min(1, (now - started) / GLIDE_MS));
        set(mixCamera(from, target, 1 - (1 - progress) ** 3));
        if (progress < 1) glide.current = requestAnimationFrame(step);
        else {
          if (source !== "follow") leading.current();
          moved.current();
        }
      };
      glide.current = requestAnimationFrame(step);
    },
    [engine, reduced],
  );

  const fit = useCallback(() => {
    if (engine) fitContent(engine, false);
  }, [engine]);
  return useMemo(() => ({ cameraRef, viewportRef, zoom, move, fit }), [move, zoom, fit]);
}

/** Engine keys the board does not offer never reach the engine: no help, library, menus or theme switch. */
function useBoardKeys(root: MutableRefObject<HTMLDivElement | null>, handlers: { readonly onTool: (tool: BoardTool) => void; readonly onZoom: (factor: number) => void; readonly canDraw: boolean }) {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const keydown = (event: KeyboardEvent) => {
      if (isTyping(event.target)) return;
      const key = event.key.toLowerCase();
      if (event.altKey && key.startsWith("arrow") && event.target instanceof Element && event.target.closest(".chalk-board-grip")) return;
      const modified = event.metaKey || event.ctrlKey;
      const { onTool, onZoom, canDraw } = latest.current;
      if (modified && !event.altKey && key === "z") return;
      if (modified && !event.altKey && key === "y") return;
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
        // Escape drops the engine back to selection, so the island moves there too; the engine still gets the key.
        if (key === "escape" && canDraw) onTool("selection");
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
export function Board({
  board,
  primary,
  visible,
  colorScheme,
  people,
  following,
  onFollow,
  sendView,
  onClose,
  isHost,
  connectionStatus,
  sceneId,
  sceneStatus,
  ownParticipantId,
  participantIds,
  whoCanDraw,
  viewBounds,
  renderCursorAvatar,
  onExport,
  phone: phoneOverride,
  downloadLabel,
  presentation = "web",
  landscapeControlsVisible = false,
}: BoardProps) {
  const root = useRef<HTMLDivElement | null>(null);
  const offline = connectionStatus === "reconnecting";
  const smallViewport = useMediaQuery("(max-width: 640px)");
  const phone = phoneOverride ?? smallViewport;
  const [engine, setEngine] = useState<WhiteboardEngineHandle | null>(null);
  const toast = useBoardToast(engine);
  const [surface, setSurface] = useState<BoardSurface>(() => readStored(SURFACE_KEY, SURFACES, "chalkboard"));
  const [place, setPlace] = useState<IslandPlace>(() => readStored(ISLAND_KEY, ISLAND_PLACES, "bottom"));
  const [tool, setTool] = useState<BoardTool>("pen");
  const [shape, setShape] = useState<ShapeTool>("rectangle");
  const [color, setColor] = useState<PenColor>("ink");
  const [width, setWidth] = useState<PenWidth>("medium");
  const [elementCount, setElementCount] = useState(0);
  const empty = elementCount === 0;
  const [narrow, setNarrow] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const canDraw = primary && (board.collab?.canDraw ?? board.canDraw ?? true);
  const compact = phone || narrow;
  const history = useEngineHistory(root, engine);
  const views = useRef(new Map<string, ChalkWhiteboardView & { readonly participantId: string }>());
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
    followingRef.current = null;
    onFollow(null);
    toast({ message: `Stopped following ${nameOf(current)}` });
  }, [nameOf, onFollow, toast]);

  const shareView = useRef<(bring: boolean, lead?: boolean) => Promise<boolean>>(async () => false);
  const viewSender = useRef(sendView);
  viewSender.current = sendView;
  const selectedFollow = useRef<string | null>(following);
  const appliedVersions = useRef(new ViewVersions());
  const previousRoster = useRef(new Set(participantIds ?? people.map((person) => person.id)));
  useEffect(() => {
    const next = new Set(participantIds ?? people.map((person) => person.id));
    for (const id of previousRoster.current) {
      if (next.has(id)) continue;
      appliedVersions.current.forgetParticipant(id);
      for (const [publisher, view] of views.current) {
        if (publisher === id || view.originParticipantId === id) views.current.delete(publisher);
      }
      cursors.current.delete(id);
    }
    previousRoster.current = next;
  }, [participantIds, people]);
  const viewsAvailable = sendView !== undefined;
  const reapplyView = useRef<() => void>(() => undefined);
  const camera = useCamera(
    engine,
    root,
    () => {
      stopFollowing();
      shareView.current(false, true);
    },
    () => shareView.current(false),
    () => reapplyView.current(),
  );

  // A relay preserves the original participant/version; receiving that version again never moves the camera.
  useEffect(() => {
    if (!visible || !viewsAvailable || !engine) return;
    let last = 0;
    let pending: ReturnType<typeof setTimeout> | undefined;
    let pendingLead = false;
    const send = async (bring: boolean) => {
      const lead = pendingLead || bring;
      pendingLead = false;
      const followedView = followingRef.current ? views.current.get(followingRef.current) : undefined;
      const selected = followedView !== undefined && selectedFollow.current === followingRef.current;
      // Older view_v1 peers cannot mark a relay's origin, so never relay their inherited motion.
      if (followedView && !followedView.originParticipantId && !followedView.ownerId && !bring) return true;
      // Relay the logical view, not the letterboxing added to fit my screen.
      const view = followedView ?? visibleView(camera.cameraRef.current, camera.viewportRef.current, viewBounds);
      last = performance.now();
      const rectangle = { x: view.x, y: view.y, width: view.width, height: view.height, bring, lead: lead || selected };
      let outgoing: ChalkWhiteboardView = rectangle;
      if (followedView && !lead) {
        if (followedView.ownerId) {
          outgoing = { ...rectangle, originParticipantId: followedView.participantId, originSequence: followedView.ownerSequence };
        } else if (followedView.originParticipantId && followedView.originSequence !== undefined) {
          outgoing = { ...rectangle, originParticipantId: followedView.originParticipantId, originSequence: followedView.originSequence, ...(followedView.originEpoch ? { originEpoch: followedView.originEpoch } : {}) };
        }
      }
      try {
        const sent = (await viewSender.current?.(outgoing)) ?? false;
        if (sent && selected) selectedFollow.current = null;
        return sent;
      } catch (error) {
        console.warn("Board view dropped.", { operation: "sendView", error });
        return false;
      }
    };
    shareView.current = (bring, lead = false) => {
      pendingLead ||= lead;
      if (bring) return send(true);
      clearTimeout(pending);
      pending = setTimeout(() => send(false), Math.max(0, VIEW_SEND_MS - (performance.now() - last)));
      return Promise.resolve(true);
    };
    const heartbeat = setInterval(() => {
      if (!followingRef.current) send(false);
    }, VIEW_HEARTBEAT_MS);
    send(false);
    return () => {
      clearInterval(heartbeat);
      clearTimeout(pending);
      shareView.current = async () => false;
    };
  }, [sceneId, sceneStatus, camera.cameraRef, camera.viewportRef, connectionStatus, engine, visible, viewsAvailable, viewBounds]);

  const { move, viewportRef } = camera;
  const goTo = useCallback(
    (participantId: string, animate: boolean, selected = false) => {
      const view = views.current.get(participantId);
      if (!view || viewportRef.current.width <= 0 || viewportRef.current.height <= 0) return;
      if (!selected && !appliedVersions.current.isNew(view, participantId)) return;
      appliedVersions.current.remember(view, participantId);
      const cursor = cursors.current.get(participantId);
      const focus = cursor && Date.now() - Date.parse(cursor.occurredAt) <= 10_000 && cursor.x >= view.x && cursor.x <= view.x + view.width && cursor.y >= view.y && cursor.y <= view.y + view.height ? { x: cursor.x, y: cursor.y, width: 0, height: 0 } : view;
      move(cameraForView(focus, viewportRef.current, camera.cameraRef.current.zoom), animate, "follow");
    },
    [move, viewportRef, camera.cameraRef],
  );

  reapplyView.current = () => {
    if (followingRef.current) goTo(followingRef.current, false, true);
  };

  // Cursors and views arrive on the board's own event stream, next to the drawing.
  const subscribe = board.collab?.subscribe;
  const latestView = useRef<(event: ChalkWhiteboardView & { readonly participantId: string }) => void>(() => undefined);
  useEffect(
    () =>
      subscribe?.((event) => {
        if (event.type !== "snapshot") return;
        views.current.clear();
        appliedVersions.current.clear();
      }),
    [subscribe],
  );
  latestView.current = (event) => {
    const previous = views.current.get(event.participantId);
    if (!event.bring && (event.participantId === ownParticipantId || (!event.ownerId && event.originParticipantId === ownParticipantId))) return;
    if (!event.bring && !appliedVersions.current.isNew(event, event.participantId)) return;
    if (!event.ownerId && !event.bring && event.originParticipantId && previous?.originParticipantId === event.originParticipantId && event.originEpoch === previous.originEpoch && event.originSequence <= previous.originSequence) return;
    const newPeer = !previous;
    views.current.delete(event.participantId);
    views.current.set(event.participantId, { ...event, bring: false });
    if (views.current.size > WHITEBOARD_VIEW_PEOPLE_MAX) {
      const oldest = views.current.keys().next().value;
      if (oldest !== undefined) views.current.delete(oldest);
    }
    // A new peer has now subscribed: announce my current view once for discovery.
    if (newPeer) {
      shareView.current(false);
    }
    if (event.bring) {
      appliedVersions.current.remember(event, event.participantId);
      followingRef.current = event.participantId;
      onFollow(event.participantId);
      toast({ message: `${nameOf(event.participantId)} brought everyone to this view` });
      goTo(event.participantId, true, true);
      return;
    }
    if (followingRef.current === event.participantId) goTo(event.participantId, true);
  };
  useEffect(() => {
    if (!subscribe) return;
    return subscribe((event) => {
      if (event.type === "cursor") {
        rememberCursor(cursors.current, event);
        if (followingRef.current === event.participantId && Date.now() - Date.parse(event.occurredAt) <= 10_000) {
          camera.move(cameraForView({ x: event.x, y: event.y, width: 0, height: 0 }, camera.viewportRef.current, camera.cameraRef.current.zoom), false, "follow");
        }
      } else if (event.type === "view") latestView.current(event);
    });
  }, [subscribe, camera.move, camera.viewportRef, camera.cameraRef]);

  useEffect(() => {
    selectedFollow.current = following;
    if (following) {
      goTo(following, true, true);
      shareView.current(false);
    }
  }, [following, goTo]);

  // The engine: tools, styles, emptiness and note text.
  useEffect(() => {
    if (engine && canDraw) applyTool(engine, tool, pen);
  }, [canDraw, engine, pen, tool]);

  // Text wraps by measuring the font, so load the board's one text font before anyone types.
  useEffect(() => {
    if (engine) void document.fonts.load(`${NOTE_FONT_PX}px Nunito`);
  }, [engine]);

  useEffect(() => {
    if (!engine) return;
    let beforeEditing = sceneSignature(engine);
    let wasEditing = false;
    setElementCount(engine.api.getSceneElements().length);
    const offChange = engine.api.onChange((elements, appState) => {
      const count = elements.filter((element) => !element.isDeleted).length;
      setElementCount(count);
      const editing = appState.editingTextElement !== null;
      if (!wasEditing && editing) beforeEditing = sceneSignature(engine);
      const finishedEditing = wasEditing && !editing;
      wasEditing = editing;
      if (finishedEditing && sceneSignature(engine) !== beforeEditing) {
        settleNoteText(engine);
      }
    });
    return () => {
      offChange();
    };
  }, [engine]);

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
  }, []);
  const redo = useCallback(() => {
    const container = root.current?.querySelector<HTMLElement>(".excalidraw");
    if (container) pressHistory(container, true);
  }, []);
  const zoomBy = useCallback(
    (factor: number) => {
      stopFollowing();
      camera.move(zoomAroundCentre(camera.cameraRef.current, camera.viewportRef.current, camera.cameraRef.current.zoom * factor), true);
    },
    [camera, stopFollowing],
  );
  useBoardKeys(root, { onTool: chooseTool, onZoom: zoomBy, canDraw });
  useImageRefusal(root, toast);

  const restyle = (next: { readonly color?: PenColor; readonly width?: PenWidth }) => {
    if (next.color) setColor(next.color);
    if (next.width) setWidth(next.width);
    if (engine) restyleSelection(engine, { ...pen, ...next }, next);
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
      const image = await boardImage(engine, surfaceFill(surface, colorScheme));
      if (onExport) {
        await onExport(image, "download");
        return;
      }
      const url = URL.createObjectURL(image);
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
      if (onExport) await onExport(image, "copy");
      else await navigator.clipboard.write([new ClipboardItem({ "image/png": image })]);
      toast({ message: "Copied the board as an image" });
    } catch {
      toast({ type: "error", message: "Copy failed. Try saving the image instead." });
    }
  };
  const bring = async () => {
    // Following someone while bringing them here would make each follow the other.
    if (followingRef.current) {
      followingRef.current = null;
      onFollow(null);
    }
    if (await shareView.current(true)) toast({ message: "Sharing your view with everyone" });
    else toast({ type: "error", message: "Could not share your view. Try again." });
  };
  const clear = async () => {
    if (!engine) return;
    try {
      const restore = await engine.clearWithUndo();
      toast({ message: "Board cleared", ...(canDraw ? { action: { label: "Undo", onClick: () => void restore() } } : {}) });
    } catch {
      toast({ type: "error", message: "Could not clear the board. Try again." });
    }
  };
  const placeNoteAt = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const container = root.current?.querySelector<HTMLElement>(".excalidraw");
    if (!engine || !container || !root.current) return;
    const rect = root.current.getBoundingClientRect();
    const { scrollX, scrollY, zoom } = camera.cameraRef.current;
    placeNote(engine, container, { x: (event.clientX - rect.left) / zoom - scrollX, y: (event.clientY - rect.top) / zoom - scrollY }, color);
    setTool("selection");
  };

  const ink = surfaceInk(surface, colorScheme);
  const surfaceVars: CSSProperties & { readonly "--board-selection": string } = { "--board-selection": selectionColor(surface, colorScheme) };
  const followed = following ? nameOf(following) : null;
  const ready = engine !== null;
  return (
    <div
      ref={root}
      className="chalk-board"
      data-presentation={presentation}
      data-call-controls={landscapeControlsVisible || undefined}
      data-surface={surface}
      data-theme={colorScheme}
      data-ready={ready || undefined}
      data-compact={compact || undefined}
      data-primary={primary || undefined}
      data-elements={elementCount}
      style={surfaceVars}
      hidden={!visible}
    >
      <BoardStyles />
      <WhiteboardCanvas {...board} headless canDraw={canDraw} collab={board.collab ? { ...board.collab, canDraw, canManage: isHost } : undefined} inkColor={ink} theme="light" isVisible={visible} className="chalk-board-engine" onEngineReady={setEngine} />
      {!ready ? (
        <div className="chalk-board-loading" role="status">
          <span className="chalk-board-spinner" aria-hidden="true" />
          Opening board
        </div>
      ) : null}
      {primary && ready && empty ? <BoardHint canDraw={canDraw} mobile={presentation === "mobile"} /> : null}
      {primary && tool === "note" && canDraw ? <div className="chalk-board-note-layer" aria-hidden="true" onPointerDown={placeNoteAt} /> : null}
      {primary ? <BoardCursors cursorsRef={cursors} cameraRef={camera.cameraRef} colorFor={colorFor} hidden={offline} renderAvatar={renderCursorAvatar} /> : null}
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
              presentation={presentation}
              surface={surface}
              onSurface={chooseSurface}
              place={!compact && canDraw ? place : undefined}
              onPlace={(next) => choosePlace(next, true)}
              downloadLabel={downloadLabel}
              onDownload={() => void download()}
              onCopy={() => void copy()}
              whoCanDraw={whoCanDraw}
              onBring={isHost && sendView ? bring : undefined}
              onClear={isHost ? () => void clear() : undefined}
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
            {presentation === "web" ? (
              <>
                <span className="chalk-board-zoom-rule" aria-hidden="true" />
                <button type="button" aria-label="Fit to content" onClick={fit}>
                  <BoardIcon name="fit" size={16} />
                </button>
              </>
            ) : null}
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
              primaryToolsFirst={presentation === "mobile"}
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

function BoardHint({ canDraw, mobile }: { readonly canDraw: boolean; readonly mobile: boolean }) {
  if (!canDraw)
    return (
      <div className="chalk-board-hint">
        <p>Nothing here yet. When someone draws, it shows up here.</p>
      </div>
    );
  return (
    <div className="chalk-board-hint">
      <p>An empty board. Draw, type or add a sticky note.</p>
      {mobile ? (
        <p>Draw with one finger. Use two fingers to move or zoom.</p>
      ) : (
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
      )}
    </div>
  );
}
