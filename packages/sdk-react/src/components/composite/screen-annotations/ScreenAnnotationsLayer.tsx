import type {
  AnnotationAccessMode,
  ScreenAnnotationItem,
  ScreenAnnotationCursor,
  ScreenAnnotationTool,
} from "@q9labs/chalk-core";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession } from "../../../context/chalk-provider";
import { useParticipants } from "../../../hooks/participants/useParticipants";
import { useScreenAnnotations } from "../../../hooks/features/useScreenAnnotations";
import { useScreenShare } from "../../../hooks/stream/useScreenShare";
import { cn } from "../../../utils/cn";
import { ScreenAnnotationsSvg } from "./ScreenAnnotationsSvg";
import { ScreenAnnotationsToolbar } from "./ScreenAnnotationsToolbar";

type ShapeTool = "rectangle" | "ellipse" | "line" | "arrow";

const isShapeTool = (
  tool: ScreenAnnotationTool,
): tool is ShapeTool =>
  tool === "rectangle" || tool === "ellipse" || tool === "line" || tool === "arrow";

const getStyleForTool = (tool: ScreenAnnotationTool) => ({
  color:
    tool === "highlighter"
      ? "#facc15"
      : tool === "text"
        ? "#f8fafc"
        : "#22d3ee",
  strokeWidth: tool === "highlighter" ? 5 : 2.5,
  opacity: tool === "highlighter" ? 0.35 : 1,
});

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const createShareSessionId = () => `share_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

const replaceOrAppend = (
  items: readonly ScreenAnnotationItem[],
  nextItem: ScreenAnnotationItem,
) => {
  const nextItems = items.filter((item) => item.id !== nextItem.id);
  nextItems.push(nextItem);
  return nextItems;
};

interface ScreenAnnotationsLayerProps {
  enabled: boolean;
  className?: string;
}

export const ScreenAnnotationsLayer = memo(
  ({ enabled, className }: ScreenAnnotationsLayerProps) => {
    const session = useSession();
    const { localParticipant } = useParticipants();
    const {
      isActive: isShareActive,
      isLocalSharing,
    } = useScreenShare();
    const {
      accessMode,
      canDraw,
      clear,
      close,
      cursors,
      isOpen,
      isSessionActive,
      items,
      open,
      shareSessionId,
      sharerParticipantId,
      startSession,
      replaceItems,
      requestSync,
      sendCursor,
      setAccessMode,
    } = useScreenAnnotations();
    const layerRef = useRef<HTMLDivElement>(null);
    const suppressHistoryResetRef = useRef(false);
    const fallbackStartRef = useRef<string | null>(null);
    const previousSessionActiveRef = useRef(false);
    const [activeTool, setActiveTool] = useState<ScreenAnnotationTool>("pen");
    const [draftItem, setDraftItem] = useState<ScreenAnnotationItem | null>(null);
    const [undoStack, setUndoStack] = useState<ScreenAnnotationItem[][]>([]);
    const [redoStack, setRedoStack] = useState<ScreenAnnotationItem[][]>([]);
    const [textDraft, setTextDraft] = useState<{
      id: string;
      x: number;
      y: number;
      value: string;
    } | null>(null);

    const isHost = localParticipant?.role === "host";
    const interactive = enabled && isOpen && canDraw && isSessionActive;
    const localSharerParticipantId = localParticipant?.id ?? null;
    const recordUiBreadcrumb = useCallback(
      (message: string, data: Record<string, unknown> = {}) => {
        session.recordIncidentBreadcrumb({
          category: "annotations_ui",
          message,
          data: {
            enabled,
            isShareActive,
            isLocalSharing,
            isSessionActive,
            isOpen,
            canDraw,
            accessMode,
            shareSessionId,
            sharerParticipantId,
            localSharerParticipantId,
            ...data,
          },
        });
      },
      [
        accessMode,
        canDraw,
        enabled,
        isLocalSharing,
        isOpen,
        isSessionActive,
        isShareActive,
        localSharerParticipantId,
        session,
        shareSessionId,
        sharerParticipantId,
      ],
    );

    useEffect(() => {
      if (!enabled || !isSessionActive) {
        setDraftItem(null);
        setTextDraft(null);
        setUndoStack([]);
        setRedoStack([]);
      }
    }, [enabled, isSessionActive]);

    useEffect(() => {
      if (!enabled || !isSessionActive) {
        return;
      }

      if (isLocalSharing && localSharerParticipantId && sharerParticipantId === localSharerParticipantId) {
        recordUiBreadcrumb("Annotation sync skipped for local owner");
        return;
      }

      recordUiBreadcrumb("Annotation sync requested from active layer", {
        trigger: "active-session-effect",
      });
      requestSync();
    }, [enabled, isLocalSharing, isSessionActive, localSharerParticipantId, recordUiBreadcrumb, requestSync, sharerParticipantId]);

    useEffect(() => {
      if (!isSessionActive && previousSessionActiveRef.current) {
        fallbackStartRef.current = null;
      }

      previousSessionActiveRef.current = isSessionActive;
    }, [isSessionActive]);

    useEffect(() => {
      if (!enabled || !isShareActive || isSessionActive) {
        if (!isShareActive) {
          fallbackStartRef.current = null;
        }
        return;
      }

      if (!isLocalSharing || !localSharerParticipantId) {
        recordUiBreadcrumb("Annotation sync requested while waiting for remote session", {
          trigger: "inactive-share-effect",
        });
        requestSync();
        return;
      }

      const fallbackKey = `${localSharerParticipantId}:${accessMode}`;
      if (fallbackStartRef.current === fallbackKey) {
        return;
      }

      const timeoutId = window.setTimeout(() => {
        fallbackStartRef.current = fallbackKey;
        recordUiBreadcrumb("Annotation fallback starting local session", {
          trigger: "fallback-timeout",
          fallbackKey,
        });
        startSession(createShareSessionId(), localSharerParticipantId, accessMode);
      }, 350);

      return () => window.clearTimeout(timeoutId);
    }, [
      accessMode,
      enabled,
      isLocalSharing,
      isSessionActive,
      isShareActive,
      localSharerParticipantId,
      recordUiBreadcrumb,
      requestSync,
      startSession,
    ]);

    useEffect(() => {
      if (suppressHistoryResetRef.current) {
        suppressHistoryResetRef.current = false;
        return;
      }

      setUndoStack([]);
      setRedoStack([]);
    }, [items]);

    const getPoint = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
      const rect = layerRef.current?.getBoundingClientRect();
      if (!rect || rect.width === 0 || rect.height === 0) {
        return null;
      }

      return {
        x: clamp01((event.clientX - rect.left) / rect.width),
        y: clamp01((event.clientY - rect.top) / rect.height),
      };
    }, []);

    const commitItems = useCallback(
      (nextItems: ScreenAnnotationItem[], mode: "push" | "replace" = "push") => {
        suppressHistoryResetRef.current = true;
        if (mode === "push") {
          setUndoStack((current) => [...current.slice(-19), items.map((item) => ({ ...item }))]);
          setRedoStack([]);
        }
        replaceItems(nextItems);
      },
      [items, replaceItems],
    );

    const handleUndo = useCallback(() => {
      setUndoStack((current) => {
        const previous = current[current.length - 1];
        if (!previous) {
          return current;
        }

        suppressHistoryResetRef.current = true;
        setRedoStack((redo) => [items.map((item) => ({ ...item })), ...redo.slice(0, 19)]);
        replaceItems(previous);
        return current.slice(0, -1);
      });
    }, [items, replaceItems]);

    const handleRedo = useCallback(() => {
      setRedoStack((current) => {
        const next = current[0];
        if (!next) {
          return current;
        }

        suppressHistoryResetRef.current = true;
        setUndoStack((undo) => [...undo.slice(-19), items.map((item) => ({ ...item }))]);
        replaceItems(next);
        return current.slice(1);
      });
    }, [items, replaceItems]);

    const handlePointerDown = useCallback(
      (event: React.PointerEvent<SVGSVGElement>) => {
        const point = getPoint(event);
        if (!interactive || !point) {
          return;
        }

        sendCursor(point.x, point.y, activeTool);

        if (activeTool === "text") {
          setTextDraft({
            id: `text_${Date.now()}`,
            x: point.x,
            y: point.y,
            value: "",
          });
          return;
        }

        const nextId = `annotation_${Date.now()}`;

        if (activeTool === "pen" || activeTool === "highlighter") {
          setDraftItem({
            id: nextId,
            type: "freehand",
            tool: activeTool,
            style: getStyleForTool(activeTool),
            points: [point],
            authorParticipantId: localParticipant?.id ?? "local",
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            version: 1,
          });
          return;
        }

        if (isShapeTool(activeTool)) {
          setDraftItem({
            id: nextId,
            type: "shape",
            shape: activeTool,
            style: getStyleForTool(activeTool),
            start: point,
            end: point,
            authorParticipantId: localParticipant?.id ?? "local",
            createdAtMs: Date.now(),
            updatedAtMs: Date.now(),
            version: 1,
          });
        }
      },
      [activeTool, getPoint, interactive, localParticipant?.id, sendCursor],
    );

    const handlePointerMove = useCallback(
      (event: React.PointerEvent<SVGSVGElement>) => {
        const point = getPoint(event);
        if (!enabled || !point) {
          return;
        }

        if (isOpen) {
          sendCursor(point.x, point.y, activeTool);
        }

        if (!interactive || !draftItem) {
          return;
        }

        if (draftItem.type === "freehand") {
          setDraftItem({
            ...draftItem,
            points: [...draftItem.points, point],
            updatedAtMs: Date.now(),
            version: draftItem.version + 1,
          });
          return;
        }

        if (draftItem.type === "shape") {
          setDraftItem({
            ...draftItem,
            end: point,
            updatedAtMs: Date.now(),
            version: draftItem.version + 1,
          });
        }
      },
      [activeTool, draftItem, enabled, getPoint, interactive, isOpen, sendCursor],
    );

    const finishDraft = useCallback(() => {
      if (!draftItem) {
        return;
      }

      commitItems(replaceOrAppend(items, draftItem));
      setDraftItem(null);
    }, [commitItems, draftItem, items]);

    const handlePointerUp = useCallback(() => {
      finishDraft();
    }, [finishDraft]);

    const commitText = useCallback(() => {
      if (!textDraft) {
        return;
      }

      const value = textDraft.value.trim();
      setTextDraft(null);
      if (!value) {
        return;
      }

      commitItems([
        ...items,
        {
          id: textDraft.id,
          type: "text",
          position: { x: textDraft.x, y: textDraft.y },
          text: value,
          style: {
            ...getStyleForTool("text"),
            fontSize: 18,
          },
          authorParticipantId: localParticipant?.id ?? "local",
          createdAtMs: Date.now(),
          updatedAtMs: Date.now(),
          version: 1,
        },
      ]);
    }, [commitItems, items, localParticipant?.id, textDraft]);

    const cursorChips = useMemo(
      () =>
        cursors.filter(
          (cursor: ScreenAnnotationCursor) =>
            cursor.participantId !== localParticipant?.id,
        ),
      [cursors, localParticipant?.id],
    );

    if (!enabled || (!isSessionActive && !isShareActive)) {
      return null;
    }

    const canLaunch = canDraw || isShareActive;

    const handleOpen = () => {
      if (!isSessionActive) {
        if (isLocalSharing && localSharerParticipantId) {
          const fallbackKey = `${localSharerParticipantId}:${accessMode}`;
          fallbackStartRef.current = fallbackKey;
          recordUiBreadcrumb("Annotation toolbar open starting local session", {
            trigger: "toolbar-open",
            fallbackKey,
          });
          startSession(createShareSessionId(), localSharerParticipantId, accessMode);
        } else {
          recordUiBreadcrumb("Annotation toolbar open requesting sync", {
            trigger: "toolbar-open",
          });
          requestSync();
        }
      }
      recordUiBreadcrumb("Annotation toolbar opened", {
        trigger: "toolbar-open",
      });
      open();
    };

    return (
      <div ref={layerRef} className={cn("absolute inset-0 z-20", className)}>
        <ScreenAnnotationsToolbar
          isOpen={isOpen}
          canDraw={canDraw}
          canLaunch={canLaunch}
          isHost={isHost}
          isSessionActive={isSessionActive}
          activeTool={activeTool}
          accessMode={accessMode}
          canUndo={undoStack.length > 0}
          canRedo={redoStack.length > 0}
          onOpen={handleOpen}
          onClose={close}
          onToolChange={setActiveTool}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onClear={() => {
            setUndoStack((current) => [...current.slice(-19), items.map((item) => ({ ...item }))]);
            setRedoStack([]);
            clear();
          }}
          onAccessModeChange={(nextMode: AnnotationAccessMode) => setAccessMode(nextMode)}
        />

        <ScreenAnnotationsSvg
          items={items}
          draftItem={draftItem}
          interactive={interactive}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerLeave={() => {
            if (isOpen) {
              finishDraft();
            }
          }}
        />

        {cursorChips.map((cursor: ScreenAnnotationCursor) => (
          <div
            key={cursor.participantId}
            className="absolute z-20 -translate-x-1/2 -translate-y-full rounded-full border border-cyan-400/25 bg-zinc-950/90 px-2 py-1 text-[10px] font-semibold text-cyan-50 shadow-lg shadow-cyan-950/30"
            style={{
              left: `${cursor.x * 100}%`,
              top: `${cursor.y * 100}%`,
            }}
          >
            {cursor.displayName}
          </div>
        ))}

        {textDraft ? (
          <textarea
            autoFocus
            value={textDraft.value}
            onChange={(event) =>
              setTextDraft((current) =>
                current ? { ...current, value: event.target.value } : current,
              )
            }
            onBlur={commitText}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                commitText();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setTextDraft(null);
              }
            }}
            className="absolute z-30 min-h-[52px] w-56 resize-none rounded-2xl border border-cyan-400/35 bg-zinc-950/85 px-3 py-2 text-sm font-medium text-white outline-none backdrop-blur-md"
            placeholder="Type note..."
            style={{
              left: `${textDraft.x * 100}%`,
              top: `${textDraft.y * 100}%`,
              transform: "translate(-10%, -10%)",
            }}
          />
        ) : null}
      </div>
    );
  },
);

ScreenAnnotationsLayer.displayName = "ScreenAnnotationsLayer";
