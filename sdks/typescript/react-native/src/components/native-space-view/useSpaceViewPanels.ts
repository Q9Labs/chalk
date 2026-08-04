import type { ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Alert, type AlertButton, Share } from "react-native";

import { useLayout, type UseLayoutReturn } from "../../hooks/useLayout";
import type { WhiteboardMetric } from "../../telemetry";
import type { SpaceViewProps } from "../SpaceView";
import { formatSpaceDuration } from "./format-space-duration";
import type { SpaceViewActionRunner, SpacePanelName } from "./types";

const emptyElements: readonly unknown[] = Object.freeze([]);
const emptyParticipants: readonly string[] = Object.freeze([]);

export interface SpaceWhiteboardState {
  readonly isOpen: boolean;
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly elements: readonly unknown[];
  readonly openParticipants: readonly string[];
  readonly transport: ChalkWhiteboardV1Transport | null;
  readonly journeyId: string;
  readonly traceparent?: string;
  readonly tracestate?: string;
  readonly onMetric?: (metric: WhiteboardMetric) => void;
  readonly open: () => void;
  readonly close: () => void;
  readonly toggle: () => void;
  readonly requestSync: () => void;
  readonly clear: () => void;
}

export interface SpaceViewPanels {
  readonly layout: UseLayoutReturn;
  readonly panel: SpacePanelName | null;
  readonly secondsElapsed: number;
  readonly formattedDuration: string;
  readonly actionsOpen: boolean;
  readonly reactionPickerOpen: boolean;
  readonly whiteboard: SpaceWhiteboardState;
  readonly setActionsOpen: Dispatch<SetStateAction<boolean>>;
  readonly setReactionPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly handleLeave: () => void;
  readonly openPanel: (nextPanel: SpacePanelName) => void;
  readonly closePanel: () => void;
  readonly handleInviteParticipants: () => void;
}

interface UseSpaceViewPanelsOptions {
  readonly spaceName?: string;
  readonly inviteLink?: string;
  readonly layout?: SpaceViewProps["layout"];
  readonly onLayoutChange?: SpaceViewProps["onLayoutChange"];
  readonly canWhiteboard: boolean;
  readonly canDraw: boolean;
  readonly canClear: boolean;
  readonly canEndEpisode: boolean;
  readonly transport: ChalkWhiteboardV1Transport | null;
  readonly onLeave: SpaceViewProps["onLeave"];
  readonly onEndEpisode: SpaceViewProps["onEndEpisode"];
  readonly run: SpaceViewActionRunner;
}

export function useSpaceViewPanels({ spaceName, inviteLink, layout: controlledLayout, onLayoutChange, canWhiteboard, canDraw, canClear, canEndEpisode, transport, onLeave, onEndEpisode, run }: UseSpaceViewPanelsOptions): SpaceViewPanels {
  const layout = useLayout({ layout: controlledLayout, onLayoutChange });
  const [panel, setPanel] = useState<SpacePanelName | null>(null);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(false);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [whiteboardOpen, setWhiteboardOpen] = useState(false);
  const journeyId = useRef(globalThis.crypto?.randomUUID?.() ?? `native-whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const startedAt = Date.now();
    const update = () => setSecondsElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    update();
    const timer = globalThis.setInterval(update, 1_000);
    return () => globalThis.clearInterval(timer);
  }, []);

  const whiteboard = useMemo<SpaceWhiteboardState>(
    () => ({
      isOpen: canWhiteboard && whiteboardOpen,
      canDraw: canWhiteboard && canDraw,
      canClear: canWhiteboard && canClear,
      elements: emptyElements,
      openParticipants: emptyParticipants,
      transport,
      journeyId: journeyId.current,
      open: () => canWhiteboard && setWhiteboardOpen(true),
      close: () => setWhiteboardOpen(false),
      toggle: () => canWhiteboard && setWhiteboardOpen((value) => !value),
      requestSync: () => void run(() => transport?.requestSnapshot()),
      clear: () => void run(() => transport?.clear()),
    }),
    [canClear, canDraw, canWhiteboard, run, transport, whiteboardOpen],
  );

  const handleLeave = useCallback(() => {
    const buttons: AlertButton[] = [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => void run(onLeave) },
    ];
    if (canEndEpisode && onEndEpisode) {
      buttons.splice(1, 0, {
        text: "End for All",
        style: "destructive",
        onPress: () => void run(onEndEpisode),
      });
    }
    Alert.alert("Leave Space?", "Choose how you want to leave.", buttons);
  }, [canEndEpisode, onEndEpisode, onLeave, run]);

  const handleInviteParticipants = useCallback(() => {
    void run(async () => {
      if (!inviteLink) throw new Error("The Space invite is not ready yet.");
      await Share.share({ message: inviteLink, title: spaceName || "Chalk Space", url: inviteLink });
    });
  }, [inviteLink, run, spaceName]);

  return {
    layout,
    panel,
    secondsElapsed,
    formattedDuration: formatSpaceDuration(secondsElapsed),
    actionsOpen,
    reactionPickerOpen,
    whiteboard,
    setActionsOpen,
    setReactionPickerOpen,
    handleLeave,
    openPanel: (nextPanel: SpacePanelName) => {
      setActionsOpen(false);
      if (nextPanel === "whiteboard") whiteboard.open();
      else setPanel(nextPanel);
    },
    closePanel: () => setPanel(null),
    handleInviteParticipants,
  };
}
