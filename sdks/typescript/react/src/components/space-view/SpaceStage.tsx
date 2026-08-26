import React, { useCallback, useMemo } from "react";

import { useSpaceClient } from "../../bindings/hooks";
import { cn } from "../../utils/cn";
import { ScreenShareViewSurface } from "../composite/ScreenShareView";
import type { Participant } from "../participant-grid/ParticipantGrid";
import { QuietSpace } from "../participant-grid/ParticipantGrid";
import { Stage, type StageLayout } from "../stage/Stage";
import { buildStageItems, WHITEBOARD_ITEM_ID, type StageItem } from "../stage/stage-items";
import { WhiteboardView } from "../whiteboard-view/WhiteboardView";
import type { SpaceViewWhiteboard } from "./SpaceView";

export interface SpaceStageProps {
  readonly tiles: readonly Participant[];
  readonly layout: StageLayout;
  readonly generatedAvatars?: boolean;
  readonly whiteboard?: SpaceViewWhiteboard;
  readonly className?: string;
}

/** The Space's stage: participants, screen shares and the whiteboard as tiles, with the app's renderers for focused content. */
export function SpaceStage({ tiles, layout, generatedAvatars = true, whiteboard, className }: SpaceStageProps): React.JSX.Element {
  const client = useSpaceClient();
  const whiteboardPresented = whiteboard?.isOpen === true;
  const items = useMemo(() => buildStageItems(tiles, whiteboardPresented), [tiles, whiteboardPresented]);

  const renderPrimaryContent = useCallback(
    (item: Extract<StageItem, { kind: "screen-share" | "whiteboard" }>) => {
      if (item.kind === "whiteboard") {
        return whiteboard ? <WhiteboardView {...whiteboard.props} className={cn("h-full min-h-0", whiteboard.props.className)} /> : null;
      }
      const stop = item.participant.isLocal ? () => void client.media.setScreenShareEnabled(false) : () => void client.participants.stopScreenShare(item.participant.id);
      return <ScreenShareViewSurface screenShareTrack={item.track} sharedByName={item.participant.displayName} participants={[]} showThumbnails={false} onStopShare={stop} className="h-full" />;
    },
    [client, whiteboard],
  );

  return <Stage items={items} layout={whiteboardPresented ? "presentation" : layout} pinnedId={whiteboardPresented ? WHITEBOARD_ITEM_ID : undefined} renderPrimaryContent={renderPrimaryContent} generatedAvatars={generatedAvatars} emptyState={<QuietSpace />} className={className} />;
}

SpaceStage.displayName = "SpaceStage";
