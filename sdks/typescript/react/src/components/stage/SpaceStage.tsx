import type { AnnotationPresentationContext } from "../screen-annotation/AnnotationSurface";
import type { ScreenAnnotationOptions } from "../screen-annotation/model";
import type { ScreenShareCapture, ScreenShareOptions } from "@q9labsai/chalk-client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { QuietSpace } from "../participant-grid/ParticipantGrid";
import { Stage, type StageLayout, type StageTileRenderContext } from "./Stage";
import { buildStageItems, type ContentItem, type StageItem } from "./stage-items";
import { usePresenting, useSelf } from "../../bindings/hooks";
import type { SpaceViewWhiteboard } from "../space-view/SpaceView";
import { renderBoardContentTile, renderDocumentContentTile, renderScreenShareContentTile } from "./space-stage-content-tiles";

export interface StageScreenAnnotation extends Omit<ScreenAnnotationOptions, "publicationId"> {
  readonly context: AnnotationPresentationContext;
  readonly publicationForTrack: (track: MediaStreamTrack) => string | undefined;
}

export interface SpaceStageProps {
  readonly pinnedId?: string | null;
  readonly onPinnedChange?: (id: string | null) => void;
  readonly tiles: readonly Participant[];
  readonly layout: StageLayout;
  readonly onLayoutChange?: (layout: StageLayout) => void;
  readonly generatedAvatars?: boolean;
  readonly whiteboard?: SpaceViewWhiteboard;
  readonly onOverflowClick?: () => void;
  readonly screenAnnotation?: StageScreenAnnotation;
  readonly shareCapture?: ScreenShareCapture;
  readonly onStopSharing?: () => Promise<void>;
  readonly onChangeShare?: (options: ScreenShareOptions) => Promise<void>;
  readonly colorScheme?: "light" | "dark";
  readonly onCloseBoard?: () => void;
  readonly className?: string;
}
/** One keyed renderer for people, the live board and each screen, in both layouts. */
export function SpaceStage({ pinnedId, onPinnedChange, tiles, layout, onLayoutChange, generatedAvatars = true, whiteboard, onOverflowClick, shareCapture, screenAnnotation, onStopSharing, onChangeShare, colorScheme = "dark", onCloseBoard, className }: SpaceStageProps): React.JSX.Element {
  const presenting = usePresenting();
  const self = useSelf();
  const documents = useMemo(
    () =>
      presenting.documents
        .filter((document) => presenting.manifests[document.documentId]?.status !== "failed" || document.presenterId === self.participantId)
        .map((document) => {
          const manifest = presenting.manifests[document.documentId];
          return { ...document, fileName: manifest?.fileName, status: manifest?.status, pageCount: manifest?.pageCount };
        }),
    [presenting.documents, presenting.manifests, self.participantId],
  );
  const items = useMemo(() => buildStageItems(tiles, whiteboard?.isOpen === true, documents), [tiles, whiteboard?.isOpen, documents]);
  const [selectedShare, setSelectedShare] = useState<string | null>(null);
  const [localPin, setLocalPin] = useState<string | null>(null);
  const pin = pinnedId === undefined ? localPin : pinnedId;
  const setPin = useCallback(
    (id: string | null) => {
      setLocalPin(id);
      onPinnedChange?.(id);
    },
    [onPinnedChange],
  );
  const [following, setFollowing] = useState<string | null | undefined>(undefined);
  const boardOpen = whiteboard?.isOpen === true && Boolean(whiteboard.props);
  const [wasBoardOpen, setWasBoardOpen] = useState(boardOpen);
  if (wasBoardOpen !== boardOpen) {
    setWasBoardOpen(boardOpen);
    if (!boardOpen) setFollowing(undefined);
  }
  const canFollow = boardOpen && Boolean(whiteboard?.sendView);
  const target = following === undefined ? whiteboard?.presenterId : following;
  const followed = canFollow && tiles.some((tile) => tile.id === target && !tile.isLocal) ? (target ?? null) : null;
  const activePin = items.some((item) => item.id === pin) ? pin : null;
  const shares = items.filter((item) => item.kind === "screen-share");
  const activeShare = selectedShare && shares.some((item) => item.id === selectedShare) ? selectedShare : null;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-tsx -- [transition] Clear departed pins through the host onPinnedChange callback after commit; also reconcile selected shares.
  useEffect(() => {
    if (pin !== activePin) setPin(activePin);
    if (selectedShare !== activeShare) setSelectedShare(activeShare);
  }, [pin, activePin, selectedShare, activeShare, setPin]);
  const follow = useCallback(
    (id: string | null) => {
      if (id) {
        setPin(null);
        setSelectedShare(null);
      }
      setFollowing(id);
    },
    [setPin],
  );
  const renderContentTile = useCallback(
    (item: ContentItem, context: StageTileRenderContext) => {
      if (item.kind === "document") return renderDocumentContentTile({ item, context, tiles });
      if (item.kind === "screen-share") return renderScreenShareContentTile({ item, context, shares, shareCapture, screenAnnotation, onStopSharing, onChangeShare, setPin, setSelectedShare });
      return renderBoardContentTile({ item, context, whiteboard, tiles, followed, follow, canFollow, onCloseBoard, colorScheme });
    },
    [follow, whiteboard, shares, shareCapture, screenAnnotation, onStopSharing, onChangeShare, colorScheme, tiles, followed, canFollow, onCloseBoard],
  );
  const focusContent = useCallback(
    (item: StageItem) => {
      if (item.kind !== "participant") onLayoutChange?.("focus");
    },
    [onLayoutChange],
  );
  return (
    <Stage
      items={items}
      layout={activePin ? "focus" : layout}
      pinnedId={activePin ?? activeShare ?? (followed ? "whiteboard" : null)}
      onPinnedChange={setPin}
      onFollowChange={canFollow ? (id) => follow(followed === id ? null : id) : undefined}
      followingId={followed}
      renderContentTile={renderContentTile}
      onItemClick={focusContent}
      onOverflowClick={onOverflowClick}
      generatedAvatars={generatedAvatars}
      emptyState={<QuietSpace />}
      className={className}
    />
  );
}
SpaceStage.displayName = "SpaceStage";
