import type { ChalkSessionSnapshot, ChalkSessionStore, ChalkWhiteboardSummary, ChalkWhiteboardV1Transport } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type SetStateAction } from "react";
import { Alert, type AlertButton, Share } from "react-native";

import { useLayout, type UseLayoutReturn } from "../../hooks/useLayout";
import type { UseRoomReturn } from "../../hooks/useRoom";
import type { Telemetry, WhiteboardMetric } from "../../telemetry";
import type { ConferenceViewProps, SpaceViewInitialState } from "../ConferenceView";
import { formatConferenceViewDuration } from "./format-meeting-room-duration";
import type { ConferenceViewActionRunner, MeetingPanelName } from "./types";

const emptyElements: readonly unknown[] = Object.freeze([]);
const emptyParticipants: readonly string[] = Object.freeze([]);

export interface MeetingWhiteboardState {
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

export interface ConferenceViewPanels {
  readonly layout: UseLayoutReturn;
  readonly panel: MeetingPanelName | null;
  readonly secondsElapsed: number;
  readonly formattedDuration: string;
  readonly actionsOpen: boolean;
  readonly reactionPickerOpen: boolean;
  readonly settingsOpen: boolean;
  readonly whiteboard: MeetingWhiteboardState;
  readonly setActionsOpen: Dispatch<SetStateAction<boolean>>;
  readonly setReactionPickerOpen: Dispatch<SetStateAction<boolean>>;
  readonly setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  readonly handleLeave: () => void;
  readonly openPanel: (nextPanel: MeetingPanelName) => void;
  readonly closePanel: () => void;
  readonly handleInviteParticipants: () => void;
}

interface UseConferenceViewPanelsOptions {
  readonly roomName?: string;
  readonly meetingLink?: string;
  readonly canWhiteboard: boolean;
  readonly isHost: boolean;
  readonly session: ConferenceViewWhiteboardSession;
  readonly room: UseRoomReturn;
  readonly telemetry: Telemetry | undefined;
  readonly onLeave: ConferenceViewProps["onLeave"];
  readonly onEndForAll: ConferenceViewProps["onEndForAll"];
  readonly run: ConferenceViewActionRunner;
  readonly initialState?: SpaceViewInitialState;
  readonly controlledState?: SpaceViewInitialState;
}

interface ConferenceViewWhiteboardSession {
  readonly whiteboard: ChalkSessionStore["whiteboard"];
  readonly subscribe: ChalkSessionStore["subscribe"];
  readonly getSnapshot: () => Pick<ChalkSessionSnapshot, "whiteboard">;
}

export function useConferenceViewPanels({ roomName, meetingLink, canWhiteboard, isHost, session, room, telemetry, onLeave, onEndForAll, run, initialState, controlledState }: UseConferenceViewPanelsOptions): ConferenceViewPanels {
  const layout = useLayout(initialState?.layout, controlledState?.layout);
  const [panel, setPanel] = useState<MeetingPanelName | null>(initialState?.panel ?? null);
  const [actionsOpen, setActionsOpen] = useState(initialState?.actionsOpen ?? false);
  const [reactionPickerOpen, setReactionPickerOpen] = useState(initialState?.reactionPickerOpen ?? false);
  const [settingsOpen, setSettingsOpen] = useState(initialState?.settingsOpen ?? false);
  const initialDurationSeconds = useRef(Math.max(0, Math.floor(initialState?.durationSeconds ?? 0))).current;
  const durationSeconds = controlledState?.durationSeconds === undefined ? initialDurationSeconds : Math.max(0, Math.floor(controlledState.durationSeconds));
  const [secondsElapsed, setSecondsElapsed] = useState(durationSeconds);
  const [whiteboardOpen, setWhiteboardOpen] = useState(initialState?.whiteboardOpen ?? false);
  const fallbackJourneyId = useRef(globalThis.crypto?.randomUUID?.() ?? `native-whiteboard-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const whiteboardSummary = useWhiteboardSummary(session);

  useEffect(() => {
    const startedAt = Date.now() - durationSeconds * 1_000;
    const update = () => setSecondsElapsed(Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)));
    update();
    const timer = globalThis.setInterval(update, 1_000);
    return () => globalThis.clearInterval(timer);
  }, [durationSeconds]);

  useEffect(() => {
    if (controlledState?.panel !== undefined) setPanel(controlledState.panel);
  }, [controlledState?.panel]);
  useEffect(() => {
    if (controlledState?.actionsOpen !== undefined) setActionsOpen(controlledState.actionsOpen);
  }, [controlledState?.actionsOpen]);
  useEffect(() => {
    if (controlledState?.reactionPickerOpen !== undefined) setReactionPickerOpen(controlledState.reactionPickerOpen);
  }, [controlledState?.reactionPickerOpen]);
  useEffect(() => {
    if (controlledState?.settingsOpen !== undefined) setSettingsOpen(controlledState.settingsOpen);
  }, [controlledState?.settingsOpen]);
  useEffect(() => {
    if (controlledState?.whiteboardOpen !== undefined) setWhiteboardOpen(controlledState.whiteboardOpen);
  }, [controlledState?.whiteboardOpen]);

  const whiteboard = useMemo<MeetingWhiteboardState>(
    () => ({
      isOpen: canWhiteboard && whiteboardOpen,
      canDraw: canWhiteboard && whiteboardSummary.canDraw,
      canClear: canWhiteboard && whiteboardSummary.canClear,
      elements: emptyElements,
      openParticipants: emptyParticipants,
      transport: session.whiteboard,
      journeyId: telemetry?.session.context.journeyId ?? fallbackJourneyId.current,
      ...(telemetry?.session.context.traceparent ? { traceparent: telemetry.session.context.traceparent } : {}),
      ...(telemetry?.session.context.tracestate ? { tracestate: telemetry.session.context.tracestate } : {}),
      ...(telemetry ? { onMetric: telemetry.recordWhiteboardMetric } : {}),
      open: () => canWhiteboard && setWhiteboardOpen(true),
      close: () => setWhiteboardOpen(false),
      toggle: () => canWhiteboard && setWhiteboardOpen((value) => !value),
      requestSync: () => void run(() => session.whiteboard?.requestSnapshot()),
      clear: () => void run(() => session.whiteboard?.clear()),
    }),
    [canWhiteboard, run, session.whiteboard, telemetry, whiteboardOpen, whiteboardSummary.canClear, whiteboardSummary.canDraw],
  );

  const handleLeave = useCallback(() => {
    const buttons: AlertButton[] = [
      { text: "Cancel", style: "cancel" },
      { text: "Leave", style: "destructive", onPress: () => void run(onLeave) },
    ];
    if (isHost && onEndForAll) {
      buttons.splice(1, 0, {
        text: "End for All",
        style: "destructive",
        onPress: () => void run(onEndForAll),
      });
    }
    Alert.alert("Leave Space?", "Choose how you want to leave this live Episode.", buttons);
  }, [isHost, onEndForAll, onLeave, run]);

  const leaveConfirmationShown = useRef(false);
  const leaveConfirmationOpen = controlledState?.leaveConfirmationOpen ?? initialState?.leaveConfirmationOpen;
  useEffect(() => {
    if (!leaveConfirmationOpen) {
      leaveConfirmationShown.current = false;
      return;
    }
    if (leaveConfirmationShown.current) return;
    leaveConfirmationShown.current = true;
    handleLeave();
  }, [handleLeave, leaveConfirmationOpen]);

  const handleInviteParticipants = useCallback(() => {
    void run(async () => {
      if (!meetingLink) throw new Error("The Space invite is not ready yet.");
      await Share.share({ message: meetingLink, title: roomName || room.roomId || "Chalk Space", url: meetingLink });
    });
  }, [meetingLink, room.roomId, roomName, run]);

  return {
    layout,
    panel,
    secondsElapsed,
    formattedDuration: formatConferenceViewDuration(secondsElapsed),
    actionsOpen,
    reactionPickerOpen,
    settingsOpen,
    whiteboard,
    setActionsOpen,
    setReactionPickerOpen,
    setSettingsOpen,
    handleLeave,
    openPanel: (nextPanel: MeetingPanelName) => {
      setActionsOpen(false);
      if (nextPanel === "whiteboard") whiteboard.open();
      else setPanel(nextPanel);
    },
    closePanel: () => setPanel(null),
    handleInviteParticipants,
  };
}

export const useSpaceViewPanels = useConferenceViewPanels;

function useWhiteboardSummary(session: Pick<ConferenceViewWhiteboardSession, "subscribe" | "getSnapshot">): ChalkWhiteboardSummary {
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const getSnapshot = useCallback(() => session.getSnapshot().whiteboard, [session]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
