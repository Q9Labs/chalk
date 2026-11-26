import type { ScreenShareCapture, ScreenShareOptions } from "@q9labsai/chalk-client";
import React, { lazy, Suspense } from "react";
import { cn } from "../../utils/cn";
import type { Participant } from "../participant-grid/ParticipantGrid";
import type { SpaceViewWhiteboard } from "../space-view/SpaceView";
import type { StageTileRenderContext } from "./Stage";
import { StageContentTile, StageContentTileSurface } from "./StageContentTile";
import type { ContentItem } from "./stage-items";
import type { StageScreenAnnotation } from "./SpaceStage";

/** Holds the board's place while its chunk loads, so the stage does not jump when the board arrives. */
function BoardOpening() {
  return (
    <div role="status" className="grid h-full place-content-center rounded-[inherit] bg-[var(--chalk-surface)] text-sm text-[var(--chalk-muted-text)]">
      Opening board
    </div>
  );
}

/** Shown when the board chunk cannot be fetched, so a bad connection does not take the call view down with it. */
function BoardUnavailable() {
  return (
    <div role="alert" className="grid h-full place-content-center rounded-[inherit] bg-[var(--chalk-surface)] px-6 text-center text-sm text-[var(--chalk-muted-text)]">
      The board could not load. Check your connection and rejoin to try again.
    </div>
  );
}

const Board = lazy(() =>
  import("../board/Board").then(
    (module) => ({ default: module.Board }),
    () => ({ default: BoardUnavailable }),
  ),
);

const DocumentView = lazy(() => import("./DocumentView").then((module) => ({ default: module.DocumentView })));

type DocumentContentItem = Extract<ContentItem, { readonly kind: "document" }>;
type ScreenShareContentItem = Extract<ContentItem, { readonly kind: "screen-share" }>;
type WhiteboardContentItem = Extract<ContentItem, { readonly kind: "whiteboard" }>;

export interface DocumentContentTileOptions {
  readonly item: DocumentContentItem;
  readonly context: StageTileRenderContext;
  readonly tiles: readonly Participant[];
}

export function renderDocumentContentTile({ item, context, tiles }: DocumentContentTileOptions): React.JSX.Element {
  return (
    <StageContentTileSurface
      item={item}
      {...context}
      mediaVisible
      media={
        <div className={cn("h-full", !context.primary && "pointer-events-none")} inert={!context.primary || undefined}>
          <Suspense fallback={<div className="grid h-full place-items-center bg-[var(--chalk-app-tile-base)] text-sm text-[var(--chalk-on-overlay)] opacity-70">Opening document</div>}>
            <DocumentView document={item.document} people={tiles} primary={context.primary} interactive={context.active} />
          </Suspense>
        </div>
      }
    />
  );
}

export interface ScreenShareContentTileOptions {
  readonly item: ScreenShareContentItem;
  readonly context: StageTileRenderContext;
  readonly shares: readonly ScreenShareContentItem[];
  readonly shareCapture?: ScreenShareCapture;
  readonly screenAnnotation?: StageScreenAnnotation;
  readonly onStopSharing?: () => Promise<void>;
  readonly onChangeShare?: (options: ScreenShareOptions) => Promise<void>;
  readonly setPin: (id: string | null) => void;
  readonly setSelectedShare: (id: string | null) => void;
}

export function renderScreenShareContentTile({ item, context, shares, shareCapture, screenAnnotation, onStopSharing, onChangeShare, setPin, setSelectedShare }: ScreenShareContentTileOptions): React.JSX.Element {
  const track = item.participant.screenShareTrack;
  const publicationId = track && screenAnnotation?.publicationForTrack(track);
  return (
    <StageContentTile
      item={item}
      {...context}
      capture={item.participant.isLocal ? shareCapture : undefined}
      annotation={screenAnnotation && publicationId ? { ...screenAnnotation, publicationId } : undefined}
      annotationContext={screenAnnotation?.context}
      onStopSharing={item.participant.isLocal ? onStopSharing : undefined}
      onChangeShare={item.participant.isLocal ? onChangeShare : undefined}
      switcher={
        shares.length > 1 ? (
          <div role="group" aria-label="Whose screen is big" className={cn("absolute left-2 z-30 flex rounded-(--corner-pill) bg-[var(--chalk-overlay-strong)] p-(--space-1)", item.participant.screenShareState === "low-quality" ? "top-11" : "top-2")}>
            {shares.map((share) => (
              <button
                key={share.id}
                type="button"
                aria-pressed={share.id === item.id}
                onClick={() => {
                  setPin(null);
                  setSelectedShare(share.id);
                }}
                className="relative h-7 rounded-(--corner-pill) px-3 text-(length:--type-caption) font-semibold text-[var(--chalk-on-overlay)] hover:bg-[var(--chalk-on-overlay)]/10 aria-pressed:bg-[var(--chalk-on-overlay)] aria-pressed:text-[var(--chalk-overlay)] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-y-2 [@media(pointer:coarse)]:before:inset-x-0"
              >
                {share.participant.displayName}
              </button>
            ))}
          </div>
        ) : null
      }
    />
  );
}

export interface BoardContentTileOptions {
  readonly item: WhiteboardContentItem;
  readonly context: StageTileRenderContext;
  readonly whiteboard?: SpaceViewWhiteboard;
  readonly tiles: readonly Participant[];
  readonly followed: string | null;
  readonly follow: (id: string | null) => void;
  readonly canFollow: boolean;
  readonly onCloseBoard?: () => void;
  readonly colorScheme: "light" | "dark";
}

export function renderBoardContentTile({ item, context, whiteboard, tiles, followed, follow, canFollow, onCloseBoard, colorScheme }: BoardContentTileOptions): React.JSX.Element {
  const boardProps = whiteboard?.props;
  return (
    <StageContentTileSurface
      item={item}
      {...context}
      mediaVisible={Boolean(boardProps)}
      media={
        boardProps ? (
          <div className={cn("h-full", !context.primary && "pointer-events-none")} inert={!context.primary || undefined}>
            <Suspense fallback={<BoardOpening />}>
              <Board board={boardProps} primary={context.primary} visible={context.active} colorScheme={colorScheme} people={tiles} following={followed} onFollow={follow} sendView={canFollow ? whiteboard?.sendView : undefined} onClose={onCloseBoard} />
            </Suspense>
          </div>
        ) : null
      }
    />
  );
}
