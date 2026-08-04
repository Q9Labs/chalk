import type { ChalkChatAttachment, ChalkSessionSnapshot, ChalkSessionStore, ConferencePhase } from "@q9labsai/chalk-client";
import { useCallback, useMemo, useRef, useState } from "react";

import type { TelemetryJourney } from "../telemetry";
import { ChalkProvider, useChalkSession } from "../context/chalk-provider";
import { useChalkSnapshot } from "../hooks/useChalkSnapshot";
import { useMeetingParticipants } from "../hooks/useMeetingParticipants";
import { useAutoJoin } from "../session/use-auto-join";
import { useConferencePhase } from "../session/use-conference-phase";
import { useJoinSession } from "../session/use-join-session";
import { useLeaveOnUnmount } from "../session/use-leave-on-unmount";
import { useVideoConferenceDiagnostics } from "../session/use-video-conference-diagnostics";
import { isIosSimulator } from "../utils/ios-simulator";
import { EndScreen, type MeetingEndData } from "./EndScreen";
import { JoinFailedScreen } from "./JoinFailedScreen";
import { JoiningScreen } from "./JoiningScreen";
import { ConferenceView as SpaceView, type ConferenceViewFeatures } from "./ConferenceView";
import { PreJoinScreen, type PreJoinSettings } from "./PreJoinScreen";
import type { ConferenceViewDiagnosticsSnapshot } from "./native-meeting-room/diagnostics";
import type { ThemeAppearance, ThemePalette, ThemeTexture } from "../ui/appearance";

export type VideoConferencePhase = "lobby" | "joining" | "meeting" | "end";

export interface MeetingJoinedData {
  readonly roomId: string;
  readonly displayName: string;
  readonly role: "host" | "participant";
  readonly joinedAt: Date;
}

export interface VideoConferenceDiagnosticsSnapshot {
  readonly phase: VideoConferencePhase;
  readonly roomId: string;
  readonly roomName: string;
  readonly lastJoinError: string | null;
  readonly connectionStatus: ChalkSessionSnapshot["state"];
  readonly isConnected: boolean;
  readonly isJoining: boolean;
  readonly session: {
    readonly state: ChalkSessionSnapshot["state"];
    readonly failure: ChalkSessionSnapshot["failure"];
  };
  readonly conferenceView: ConferenceViewDiagnosticsSnapshot | null;
}

export interface VideoConferenceProps {
  readonly roomId: string;
  readonly roomName?: string;
  readonly meetingLink?: string;
  readonly userName?: string;
  readonly role?: "host" | "participant";
  readonly autoJoin?: boolean;
  readonly initialPhase?: VideoConferencePhase;
  readonly initialJoinSettings?: Partial<PreJoinSettings>;
  readonly features?: ConferenceViewFeatures;
  readonly initialPalette?: ThemePalette;
  readonly initialTexture?: ThemeTexture;
  readonly onAppearanceChange?: (appearance: ThemeAppearance) => void;
  readonly telemetry?: TelemetryJourney;
  readonly createSession: (settings: PreJoinSettings) => ChalkSessionStore | Promise<ChalkSessionStore>;
  readonly pickChatAttachments?: (chatFiles: NonNullable<ChalkSessionStore["chatFiles"]>) => Promise<readonly ChalkChatAttachment[]>;
  readonly onSessionChange?: (session: ChalkSessionStore | null) => void;
  readonly onJoin?: (data: MeetingJoinedData) => void;
  readonly onLeave?: () => void;
  readonly onEnd?: (data: MeetingEndData) => void;
  readonly onClose?: () => void;
  readonly onError?: (error: Error) => void;
  readonly onDiagnosticsChange?: (snapshot: VideoConferenceDiagnosticsSnapshot) => void;
}

export function VideoConference(props: VideoConferenceProps): React.JSX.Element {
  const simulatorMediaDisabled = isIosSimulator();
  const defaultSettings = useMemo(
    (): PreJoinSettings => ({
      displayName: props.initialJoinSettings?.displayName?.trim() || props.userName?.trim() || "Guest",
      microphoneEnabled: simulatorMediaDisabled ? false : (props.initialJoinSettings?.microphoneEnabled ?? false),
      cameraEnabled: simulatorMediaDisabled ? false : (props.initialJoinSettings?.cameraEnabled ?? false),
    }),
    [props.initialJoinSettings, props.role, props.userName, simulatorMediaDisabled],
  );
  const [session, setSession] = useState<ChalkSessionStore | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [hasAskedToJoin, setHasAskedToJoin] = useState(props.autoJoin || props.initialPhase === "joining");
  const [hasAskedToLeave, setHasAskedToLeave] = useState(props.initialPhase === "end");
  const [joinError, setJoinError] = useState<string | null>(null);
  const [endData, setEndData] = useState<MeetingEndData | null>(null);
  const creationAttempt = useRef(0);
  const phase = toVideoConferencePhase(useConferencePhase(session, { hasAskedToJoin, hasAskedToLeave }, creationAttempt.current === 0 ? props.initialPhase : undefined));
  const begin = useCallback(
    async (nextSettings: PreJoinSettings) => {
      const normalized = {
        ...nextSettings,
        displayName: nextSettings.displayName.trim() || defaultSettings.displayName,
        microphoneEnabled: simulatorMediaDisabled ? false : nextSettings.microphoneEnabled,
        cameraEnabled: simulatorMediaDisabled ? false : nextSettings.cameraEnabled,
      };
      const attempt = ++creationAttempt.current;
      setHasAskedToJoin(true);
      setHasAskedToLeave(false);
      setSettings(normalized);
      setJoinError(null);
      setEndData(null);
      try {
        const nextSession = await props.createSession(normalized);
        if (attempt !== creationAttempt.current) {
          await nextSession.leave().catch(() => undefined);
          return;
        }
        setSession(nextSession);
        props.onSessionChange?.(nextSession);
      } catch (cause) {
        if (attempt !== creationAttempt.current) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setJoinError(error.message);
        setHasAskedToJoin(false);
        props.onError?.(error);
      }
    },
    [defaultSettings.displayName, props.createSession, props.onError, props.onSessionChange, simulatorMediaDisabled],
  );
  useLeaveOnUnmount(session, () => {
    creationAttempt.current += 1;
  });
  useAutoJoin((props.autoJoin || props.initialPhase === "joining") && !session, () => begin(defaultSettings));

  const handleJoinFailure = useCallback(
    (error: Error) => {
      void session?.leave().catch(() => undefined);
      setSession((current) => (current === session ? null : current));
      props.onSessionChange?.(null);
      setJoinError(error.message);
      setHasAskedToJoin(false);
      setHasAskedToLeave(false);
      props.onError?.(error);
    },
    [props.onError, props.onSessionChange, session],
  );

  if (phase === "lobby") {
    return (
      <PreJoinScreen
        error={joinError}
        initialAudioEnabled={settings.microphoneEnabled}
        initialVideoEnabled={settings.cameraEnabled}
        onCancel={props.onClose}
        onJoin={(nextSettings) => void begin(nextSettings)}
        role={props.role}
        roomName={props.roomName || props.roomId}
        userName={settings.displayName}
      />
    );
  }

  if (phase === "joining" && !session) {
    return <JoiningScreen displayName={settings.displayName} message={`Preparing ${props.roomName || props.roomId}`} supportingMessages={["Opening the Space...", "Preparing Participant access...", "Connecting to Chalk..."]} />;
  }

  if (phase === "end" && endData) {
    return (
      <EndScreen
        data={endData}
        onGoHome={() => props.onClose?.()}
        onRejoin={() => {
          setSession(null);
          props.onSessionChange?.(null);
          setHasAskedToJoin(false);
          setHasAskedToLeave(false);
        }}
      />
    );
  }

  if (!session) return <></>;

  return (
    <ChalkProvider session={session} telemetry={props.telemetry}>
      <ActiveVideoConference {...props} joinError={joinError} phase={phase} settings={settings} setEndData={setEndData} setHasAskedToLeave={setHasAskedToLeave} setJoinError={setJoinError} onJoinFailure={handleJoinFailure} />
    </ChalkProvider>
  );
}

type ActiveVideoConferenceProps = VideoConferenceProps & {
  readonly settings: PreJoinSettings;
  readonly phase: VideoConferencePhase;
  readonly joinError: string | null;
  readonly setHasAskedToLeave: (asked: boolean) => void;
  readonly setJoinError: (message: string | null) => void;
  readonly setEndData: (data: MeetingEndData) => void;
  readonly onJoinFailure: (error: Error) => void;
};

function ActiveVideoConference(props: ActiveVideoConferenceProps): React.JSX.Element {
  const session = useChalkSession();
  const snapshot = useChalkSnapshot();
  const participants = useMeetingParticipants();
  const [conferenceViewDiagnostics, setConferenceViewDiagnostics] = useState<ConferenceViewDiagnosticsSnapshot | null>(null);

  const joinedAt = useJoinSession({
    session,
    state: snapshot.state,
    onFailure: props.onJoinFailure,
    onJoined: (date) => {
      props.setJoinError(null);
      props.onJoin?.({
        roomId: props.roomId,
        displayName: props.settings.displayName,
        role: props.role ?? "participant",
        joinedAt: date,
      });
    },
  });
  useVideoConferenceDiagnostics({
    session,
    phase: props.phase,
    roomId: props.roomId,
    roomName: props.roomName,
    joinError: props.joinError,
    conferenceView: conferenceViewDiagnostics,
    onChange: props.onDiagnosticsChange,
  });

  const finish = useCallback(async () => {
    try {
      await session.leave();
    } finally {
      const data = meetingEndData(props, joinedAt.current, participants.participantCount, snapshot.chat.messages.length);
      props.setEndData(data);
      props.setHasAskedToLeave(true);
      props.onSessionChange?.(null);
      props.onLeave?.();
      props.onEnd?.(data);
    }
  }, [participants.participantCount, props.onEnd, props.onLeave, props.onSessionChange, props.roomId, props.roomName, props.setEndData, props.setHasAskedToLeave, session, snapshot.chat.messages.length]);
  const endForAll = useCallback(async () => {
    await session.endSession();
    await finish();
  }, [finish, session]);

  if (props.phase === "joining") {
    return <JoiningScreen displayName={props.settings.displayName} message={`Entering ${props.roomName || props.roomId}`} supportingMessages={["Preparing your media...", "Syncing Space settings...", "Picking the fastest route...", "Opening the Space..."]} />;
  }

  if (snapshot.state === "failed") {
    return <JoinFailedScreen roomName={props.roomName || props.roomId} message={snapshot.failure?.message ?? props.joinError ?? "Unable to enter the Space."} onRetry={() => void session.join().catch(props.onJoinFailure)} onHome={() => void session.leave().finally(() => props.onClose?.())} />;
  }

  return (
    <SpaceView
      features={props.features}
      initialPalette={props.initialPalette}
      initialTexture={props.initialTexture}
      meetingLink={props.meetingLink}
      onAppearanceChange={props.onAppearanceChange}
      onDiagnosticsChange={setConferenceViewDiagnostics}
      onEndForAll={props.role === "host" ? endForAll : undefined}
      onLeave={finish}
      pickChatAttachments={props.pickChatAttachments}
      roomName={props.roomName || props.roomId}
    />
  );
}

function toVideoConferencePhase(phase: ConferencePhase): VideoConferencePhase {
  switch (phase) {
    case "prejoin":
      return "lobby";
    case "joining":
    case "waiting":
      return "joining";
    case "active":
    case "reconnecting":
      return "meeting";
    case "ended":
      return "end";
  }
}

function meetingEndData(props: VideoConferenceProps, joinedAt: Date | null, participantCount: number, chatCount: number): MeetingEndData {
  return {
    roomId: props.roomId,
    roomName: props.roomName || props.roomId,
    durationSeconds: joinedAt ? Math.max(0, Math.round((Date.now() - joinedAt.getTime()) / 1_000)) : 0,
    participantCount,
    chatCount,
  };
}
