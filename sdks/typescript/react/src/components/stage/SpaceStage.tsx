import type { ScreenShareCapture, ScreenShareOptions } from "@q9labsai/chalk-client";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "../../utils/cn";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { QuietSpace } from "../participant-grid/ParticipantGrid";
import { Stage, type StageLayout, type StageTileRenderContext } from "./Stage";
import { buildStageItems, type StageItem } from "./stage-items";
import { StageContentTile, StageContentTileSurface } from "./StageContentTile";
import { Board } from "../board/Board";
import type { SpaceViewWhiteboard } from "../space-view/SpaceView";

export interface SpaceStageProps {
  readonly pinnedId?: string | null;
  readonly onPinnedChange?: (id: string | null) => void;
  readonly tiles: readonly Participant[];
  readonly layout: StageLayout;
  readonly onLayoutChange?: (layout: StageLayout) => void;
  readonly generatedAvatars?: boolean;
  readonly whiteboard?: SpaceViewWhiteboard;
  readonly onOverflowClick?: () => void;
  readonly shareCapture?: ScreenShareCapture;
  readonly onStopSharing?: () => Promise<void>;
  readonly onChangeShare?: (options: ScreenShareOptions) => Promise<void>;
  readonly colorScheme?: "light" | "dark";
  readonly onCloseBoard?: () => void;
  readonly className?: string;
}
/** One keyed renderer for people, the live board and each screen, in both layouts. */
export function SpaceStage({ pinnedId, onPinnedChange, tiles, layout, onLayoutChange, generatedAvatars = true, whiteboard, onOverflowClick, shareCapture, onStopSharing, onChangeShare, colorScheme = "dark", onCloseBoard, className }: SpaceStageProps): React.JSX.Element {
  const items = useMemo(() => buildStageItems(tiles, whiteboard?.isOpen === true), [tiles, whiteboard?.isOpen]);
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
    (item: Extract<StageItem, { kind: "screen-share" | "whiteboard" }>, context: StageTileRenderContext) => {
      if (item.kind === "screen-share")
        return (
          <StageContentTile
            item={item}
            {...context}
            capture={item.participant.isLocal ? shareCapture : undefined}
            onStopSharing={item.participant.isLocal ? onStopSharing : undefined}
            onChangeShare={item.participant.isLocal ? onChangeShare : undefined}
            switcher={
              shares.length > 1 ? (
                <div role="group" aria-label="Whose screen is big" className={cn("absolute left-2 z-30 flex rounded-[999px] bg-[var(--chalk-overlay-strong)] p-[3px]", item.participant.screenShareState === "low-quality" ? "top-11" : "top-2")}>
                  {shares.map((share) => (
                    <button
                      key={share.id}
                      type="button"
                      aria-pressed={share.id === item.id}
                      onClick={() => {
                        setPin(null);
                        setSelectedShare(share.id);
                      }}
                      className="relative h-7 rounded-[999px] px-3 text-[12px] font-semibold text-[var(--chalk-on-overlay)] hover:bg-[var(--chalk-on-overlay)]/10 aria-pressed:bg-[var(--chalk-on-overlay)] aria-pressed:text-[var(--chalk-overlay)] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-y-2 [@media(pointer:coarse)]:before:inset-x-0"
                    >
                      {share.participant.displayName}
                    </button>
                  ))}
                </div>
              ) : null
            }
          />
        );
      const boardProps = whiteboard?.props;
      return (
        <StageContentTileSurface
          item={item}
          {...context}
          mediaVisible={Boolean(boardProps)}
          media={
            boardProps ? (
              <div className={cn("h-full", !context.primary && "pointer-events-none")} inert={!context.primary || undefined}>
                <Board board={boardProps} primary={context.primary} visible={context.active} colorScheme={colorScheme} people={tiles} following={followed} onFollow={follow} sendView={canFollow ? whiteboard?.sendView : undefined} onClose={onCloseBoard} />
              </div>
            ) : null
          }
        />
      );
    },
    [follow, whiteboard, shares, shareCapture, onStopSharing, onChangeShare, colorScheme, tiles, followed, canFollow, onCloseBoard],
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
