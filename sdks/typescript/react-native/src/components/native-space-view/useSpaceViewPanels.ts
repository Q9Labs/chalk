import type { ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Alert, type AlertButton, Share } from "react-native";

import { useLayout, type UseLayoutReturn } from "../../hooks/useLayout";
import type { NativeJourneyContext, WhiteboardMetric } from "../../telemetry";
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
  readonly settingsOpen: boolean;
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
  readonly journeyContext?: NativeJourneyContext;
  /** Test-fixture state only; SpaceView does not expose controlled panel state publicly. */
  readonly initialState?: SpaceViewFixtureState;
  /** Test-fixture state only; SpaceView does not expose controlled panel state publicly. */
  readonly controlledState?: SpaceViewFixtureState;
}

type SpaceViewFixtureState = {
  readonly layout?: SpaceViewProps["layout"];
  readonly panel?: SpacePanelName | null;
  readonly actionsOpen?: boolean;
  readonly reactionPickerOpen?: boolean;
  readonly settingsOpen?: boolean;
  readonly durationSeconds?: number;
  readonly whiteboardOpen?: boolean;
};

export function useSpaceViewPanels({ spaceName, inviteLink, layout: controlledLayout, onLayoutChange, canWhiteboard, canDraw, canClear, canEndEpisode, transport, onLeave, onEndEpisode, run, journeyContext, initialState, controlledState }: UseSpaceViewPanelsOptions): SpaceViewPanels {
  const fixtureLayout = controlledState?.layout ?? initialState?.layout ?? controlledLayout;
  const layout = useLayout({ layout: fixtureLayout, onLayoutChange });
  const [panel, setPanel] = useState<SpacePanelName | null>(initialState?.panel ?? null);
  const [actionsOpen, setActionsOpen] = useState(initialState?.actionsOpen ?? false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(initialState?.reactionPickerOpen ?? false);
  const [secondsElapsed, setSecondsElapsed] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(initialState?.settingsOpen ?? false);
  const [whiteboardOpen, setWhiteboardOpen] = useState(initialState?.whiteboardOpen ?? false);
  const generatedJourneyId = useRef(globalThis.crypto?.randomUUID?.() ?? `native-whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    const durationSeconds = Math.max(0, Math.floor(controlledState?.durationSeconds ?? initialState?.durationSeconds ?? 0));
    const startedAt = Date.now() - durationSeconds * 1_000;
    const update = () => setSecondsElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    update();
    const timer = globalThis.setInterval(update, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [controlledState?.durationSeconds, initialState?.durationSeconds]);

  useEffect(() => {
    if (controlledState?.panel !== undefined) setPanel(controlledState.panel ?? null);
    if (controlledState?.actionsOpen !== undefined) setActionsOpen(controlledState.actionsOpen);
    if (controlledState?.reactionPickerOpen !== undefined) setReactionPickerOpen(controlledState.reactionPickerOpen);
    if (controlledState?.settingsOpen !== undefined) setSettingsOpen(controlledState.settingsOpen);
    if (controlledState?.whiteboardOpen !== undefined) setWhiteboardOpen(controlledState.whiteboardOpen);
  }, [controlledState]);

  const whiteboard = useMemo<SpaceWhiteboardState>(
    () => ({
      isOpen: canWhiteboard && whiteboardOpen,
      canDraw: canWhiteboard && canDraw,
      canClear: canWhiteboard && canClear,
      elements: emptyElements,
      openParticipants: emptyParticipants,
      transport,
      journeyId: journeyContext?.journeyId ?? generatedJourneyId.current,
      ...(journeyContext?.traceparent ? { traceparent: journeyContext.traceparent } : {}),
      ...(journeyContext?.tracestate ? { tracestate: journeyContext.tracestate } : {}),
      ...(journeyContext ? { onMetric: journeyContext.recordWhiteboardMetric } : {}),
      open: () => canWhiteboard && setWhiteboardOpen(true),
      close: () => setWhiteboardOpen(false),
      toggle: () => canWhiteboard && setWhiteboardOpen((value) => !value),
      requestSync: () => void run(() => transport?.requestSnapshot()),
      clear: () => void run(() => transport?.clear()),
    }),
    [canClear, canDraw, canWhiteboard, journeyContext, run, transport, whiteboardOpen],
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
    settingsOpen,
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
