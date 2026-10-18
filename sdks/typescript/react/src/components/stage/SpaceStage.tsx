import React, { useCallback, useMemo } from "react";

import { cn } from "../../utils/cn";
import { ScreenShareViewSurface } from "../composite/ScreenShareView";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { QuietSpace } from "../participant-grid/ParticipantGrid";
import { Stage, type StageLayout, type StageTileRenderContext } from "../stage/Stage";
import { buildStageItems, type StageItem } from "../stage/stage-items";
import { StageContentTile, StageContentTileSurface } from "../stage/StageContentTile";
import { WhiteboardView } from "../whiteboard-view/WhiteboardView";
import type { SpaceViewWhiteboard } from "../space-view/SpaceView";

export interface SpaceStageProps {
  readonly tiles: readonly Participant[];
  readonly layout: StageLayout;
  readonly onLayoutChange?: (layout: StageLayout) => void;
  readonly generatedAvatars?: boolean;
  readonly whiteboard?: SpaceViewWhiteboard;
  readonly className?: string;
}

/** The Space's stage: participants, screen shares and the whiteboard as tiles, with the app's renderers for focused content. */
export function SpaceStage({ tiles, layout, onLayoutChange, generatedAvatars = true, whiteboard, className }: SpaceStageProps): React.JSX.Element {
  const items = useMemo(() => buildStageItems(tiles, whiteboard?.isOpen === true), [tiles, whiteboard?.isOpen]);

  const renderPrimaryContent = useCallback(
    (item: Extract<StageItem, { kind: "screen-share" | "whiteboard" }>) => {
      if (item.kind === "whiteboard") {
        return whiteboard ? <WhiteboardView {...whiteboard.props} className={cn("h-full !min-h-0", whiteboard.props.className)} /> : null;
      }
      const track = item.participant.screenShareTrack;
      if (!track) return null;
      return <ScreenShareViewSurface screenShareTrack={track} sharedByName={item.participant.displayName} className="h-full" />;
    },
    [whiteboard],
  );

  const renderContentTile = useCallback(
    (item: Extract<StageItem, { kind: "screen-share" | "whiteboard" }>, context: StageTileRenderContext) => {
      if (item.kind === "screen-share") return <StageContentTile item={item} {...context} />;
      return (
        <StageContentTileSurface
          item={item}
          {...context}
          mediaVisible={Boolean(whiteboard)}
          media={
            whiteboard ? (
              <div className="pointer-events-none h-full" inert>
                <WhiteboardView {...whiteboard.props} canDraw={false} collab={whiteboard.props.collab ? { ...whiteboard.props.collab, canDraw: false } : undefined} isVisible={context.active} className={cn("h-full !min-h-0", whiteboard.props.className)} />
              </div>
            ) : null
          }
        />
      );
    },
    [whiteboard],
  );
  const focusContent = useCallback(
    (item: StageItem) => {
      if (item.kind !== "participant") onLayoutChange?.("focus");
    },
    [onLayoutChange],
  );

  return <Stage animate={false} items={items} layout={layout} renderPrimaryContent={renderPrimaryContent} renderContentTile={renderContentTile} onItemClick={focusContent} generatedAvatars={generatedAvatars} emptyState={<QuietSpace />} className={className} />;
}

SpaceStage.displayName = "SpaceStage";
