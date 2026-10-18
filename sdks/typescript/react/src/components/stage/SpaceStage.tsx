import type { ScreenShareCapture, ScreenShareOptions } from "@q9labsai/chalk-client";
import React, { useCallback, useMemo, useState } from "react";
import { cn } from "../../utils/cn";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { QuietSpace } from "../participant-grid/ParticipantGrid";
import { Stage, type StageLayout, type StageTileRenderContext } from "./Stage";
import { buildStageItems, type StageItem } from "./stage-items";
import { StageContentTile, StageContentTileSurface } from "./StageContentTile";
import { WhiteboardView } from "../whiteboard-view/WhiteboardView";
import type { SpaceViewWhiteboard } from "../space-view/SpaceView";

export interface SpaceStageProps {
  readonly tiles: readonly Participant[];
  readonly layout: StageLayout;
  readonly onLayoutChange?: (layout: StageLayout) => void;
  readonly generatedAvatars?: boolean;
  readonly whiteboard?: SpaceViewWhiteboard;
  readonly onOverflowClick?: () => void;
  readonly shareCapture?: ScreenShareCapture;
  readonly onStopSharing?: () => Promise<void>;
  readonly onChangeShare?: (options: ScreenShareOptions) => Promise<void>;
  readonly className?: string;
}
/** One keyed renderer for people, the live board and each screen, in both layouts. */
export function SpaceStage({ tiles, layout, onLayoutChange, generatedAvatars = true, whiteboard, onOverflowClick, shareCapture, onStopSharing, onChangeShare, className }: SpaceStageProps): React.JSX.Element {
  const items = useMemo(() => buildStageItems(tiles, whiteboard?.isOpen === true), [tiles, whiteboard?.isOpen]);
  const [selectedShare, setSelectedShare] = useState<string | null>(null);
  const [pin, setPin] = useState<string | null>(null);
  const shares = items.filter((item) => item.kind === "screen-share");
  const activeShare = selectedShare && shares.some((item) => item.id === selectedShare) ? selectedShare : null;
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
                <div role="group" aria-label="Whose screen is big" className={cn("absolute left-2 z-30 flex rounded-full bg-[rgba(12,14,18,.82)] p-[3px]", item.participant.screenShareState === "low-quality" ? "top-11" : "top-2")}>
                  {shares.map((share) => (
                    <button
                      key={share.id}
                      type="button"
                      aria-pressed={share.id === item.id}
                      onClick={() => {
                        setPin(null);
                        setSelectedShare(share.id);
                      }}
                      className="h-7 rounded-full px-3 text-[12px] font-semibold text-[#d4d5d9] hover:bg-white/10 aria-pressed:bg-white aria-pressed:text-[#0b0c0e] [@media(pointer:coarse)]:min-h-11"
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
                <WhiteboardView
                  {...boardProps}
                  canDraw={context.primary ? boardProps.canDraw : false}
                  collab={boardProps.collab ? { ...boardProps.collab, canDraw: context.primary && boardProps.collab.canDraw } : undefined}
                  isVisible={context.active}
                  className={cn("h-full !min-h-0", boardProps.className)}
                />
              </div>
            ) : null
          }
        />
      );
    },
    [whiteboard, shares, shareCapture, onStopSharing, onChangeShare],
  );
  const focusContent = useCallback(
    (item: StageItem) => {
      if (item.kind !== "participant") onLayoutChange?.("focus");
    },
    [onLayoutChange],
  );
  return <Stage items={items} layout={layout} pinnedId={pin ?? activeShare} onPinnedChange={setPin} renderContentTile={renderContentTile} onItemClick={focusContent} onOverflowClick={onOverflowClick} generatedAvatars={generatedAvatars} emptyState={<QuietSpace />} className={className} />;
}
SpaceStage.displayName = "SpaceStage";
