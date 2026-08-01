import type { ChalkChatAttachment, ChalkSessionSnapshot, ChalkSessionStore } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import type { TelemetryJourney } from "../telemetry";
import { ChalkProvider, useChalkSession } from "../context/chalk-provider";
import { useChalkSnapshot } from "../hooks/useChalkSnapshot";
import { useMeetingParticipants } from "../hooks/useMeetingParticipants";
import { Theme } from "../ui/theme";
import { isIosSimulator } from "../utils/ios-simulator";
import { EndScreen, type MeetingEndData } from "./EndScreen";
import { JoiningLoadingScreen } from "./JoiningLoadingScreen";
import { MeetingRoom, type MeetingRoomFeatures } from "./MeetingRoom";
import { PreJoinLobby, type JoinSettings } from "./PreJoinLobby";
import type { MeetingRoomDiagnosticsSnapshot } from "./native-meeting-room/diagnostics";

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
  readonly meetingRoom: MeetingRoomDiagnosticsSnapshot | null;
}

export interface VideoConferenceProps {
  readonly roomId: string;
  readonly roomName?: string;
  readonly meetingLink?: string;
  readonly userName?: string;
  readonly role?: "host" | "participant";
  readonly autoJoin?: boolean;
  readonly initialPhase?: VideoConferencePhase;
  readonly initialJoinSettings?: Partial<JoinSettings>;
  readonly features?: MeetingRoomFeatures;
  readonly telemetry?: TelemetryJourney;
  readonly createSession: (settings: JoinSettings) => ChalkSessionStore | Promise<ChalkSessionStore>;
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
    (): JoinSettings => ({
      displayName: props.initialJoinSettings?.displayName?.trim() || props.userName?.trim() || (props.role === "host" ? "Host" : "Guest"),
      audioEnabled: simulatorMediaDisabled ? false : (props.initialJoinSettings?.audioEnabled ?? false),
      videoEnabled: simulatorMediaDisabled ? false : (props.initialJoinSettings?.videoEnabled ?? false),
    }),
    [props.initialJoinSettings, props.role, props.userName, simulatorMediaDisabled],
  );
  const [session, setSession] = useState<ChalkSessionStore | null>(null);
  const [settings, setSettings] = useState(defaultSettings);
  const [phase, setPhase] = useState<VideoConferencePhase>(props.initialPhase ?? (props.autoJoin ? "joining" : "lobby"));
  const [joinError, setJoinError] = useState<string | null>(null);
  const [endData, setEndData] = useState<MeetingEndData | null>(null);
  const creationAttempt = useRef(0);
  const sessionRef = useRef<ChalkSessionStore | null>(null);
  sessionRef.current = session;
  const begin = useCallback(
    async (nextSettings: JoinSettings) => {
      const normalized = {
        ...nextSettings,
        displayName: nextSettings.displayName.trim() || defaultSettings.displayName,
        audioEnabled: simulatorMediaDisabled ? false : nextSettings.audioEnabled,
        videoEnabled: simulatorMediaDisabled ? false : nextSettings.videoEnabled,
      };
      const attempt = ++creationAttempt.current;
      setSettings(normalized);
      setJoinError(null);
      setEndData(null);
      setPhase("joining");
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
        setPhase("lobby");
        props.onError?.(error);
      }
    },
    [defaultSettings.displayName, props.createSession, props.onError, props.onSessionChange, simulatorMediaDisabled],
  );
  const startedAutomatically = useRef(false);

  useEffect(
    () => () => {
      creationAttempt.current += 1;
      void sessionRef.current?.leave().catch(() => undefined);
    },
    [],
  );

  useEffect(() => {
    if ((!props.autoJoin && props.initialPhase !== "joining") || startedAutomatically.current || session) return;
    startedAutomatically.current = true;
    void begin(defaultSettings);
  }, [begin, defaultSettings, props.autoJoin, props.initialPhase, session]);

  const handleJoinFailure = useCallback(
    (error: Error) => {
      void session?.leave().catch(() => undefined);
      setSession((current) => (current === session ? null : current));
      props.onSessionChange?.(null);
      setJoinError(error.message);
      setPhase("lobby");
      props.onError?.(error);
    },
    [props.onError, props.onSessionChange, session],
  );

  if (phase === "lobby") {
    return (
      <PreJoinLobby error={joinError} initialAudioEnabled={settings.audioEnabled} initialVideoEnabled={settings.videoEnabled} onCancel={props.onClose} onJoin={(nextSettings) => void begin(nextSettings)} role={props.role} roomName={props.roomName || props.roomId} userName={settings.displayName} />
    );
  }

  if (phase === "joining" && !session) {
    return <JoiningLoadingScreen displayName={settings.displayName} message={`Preparing ${props.roomName || props.roomId}`} supportingMessages={["Opening the meeting...", "Preparing participant access...", "Connecting to Chalk..."]} />;
  }

  if (phase === "end" && endData) {
    return (
      <EndScreen
        data={endData}
        onGoHome={() => props.onClose?.()}
        onRejoin={() => {
          setSession(null);
          props.onSessionChange?.(null);
          setPhase("lobby");
        }}
      />
    );
  }

  if (!session) return <></>;

  return (
    <ChalkProvider session={session} telemetry={props.telemetry}>
      <ActiveVideoConference {...props} joinError={joinError} phase={phase} settings={settings} setEndData={setEndData} setJoinError={setJoinError} setPhase={setPhase} onJoinFailure={handleJoinFailure} />
    </ChalkProvider>
  );
}

type ActiveVideoConferenceProps = VideoConferenceProps & {
  readonly settings: JoinSettings;
  readonly phase: VideoConferencePhase;
  readonly joinError: string | null;
  readonly setPhase: (phase: VideoConferencePhase) => void;
  readonly setJoinError: (message: string | null) => void;
  readonly setEndData: (data: MeetingEndData) => void;
  readonly onJoinFailure: (error: Error) => void;
};

function ActiveVideoConference(props: ActiveVideoConferenceProps): React.JSX.Element {
  const session = useChalkSession();
  const snapshot = useChalkSnapshot();
  const participants = useMeetingParticipants();
  const joinedAt = useRef<Date | null>(null);
  const joined = useRef(false);
  const [meetingRoomDiagnostics, setMeetingRoomDiagnostics] = useState<MeetingRoomDiagnosticsSnapshot | null>(null);

  useEffect(() => {
    void session.join().catch((cause: unknown) => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      props.onJoinFailure(error);
    });
  }, [props.onJoinFailure, session]);

  useEffect(() => {
    if (snapshot.state !== "live" || joined.current) return;
    joined.current = true;
    joinedAt.current = new Date();
    props.setJoinError(null);
    props.setPhase("meeting");
    props.onJoin?.({
      roomId: props.roomId,
      displayName: props.settings.displayName,
      role: props.role ?? "participant",
      joinedAt: joinedAt.current,
    });
  }, [props.onJoin, props.role, props.roomId, props.setJoinError, props.setPhase, props.settings.displayName, snapshot.state]);

  useEffect(() => {
    props.onDiagnosticsChange?.({
      phase: props.phase,
      roomId: props.roomId,
      roomName: props.roomName || props.roomId,
      lastJoinError: props.joinError,
      connectionStatus: snapshot.state,
      isConnected: snapshot.state === "live",
      isJoining: snapshot.state === "joining",
      session: { state: snapshot.state, failure: snapshot.failure },
      meetingRoom: meetingRoomDiagnostics,
    });
  }, [meetingRoomDiagnostics, props.joinError, props.onDiagnosticsChange, props.phase, props.roomId, props.roomName, snapshot.failure, snapshot.state]);

  const finish = useCallback(async () => {
    try {
      await session.leave();
    } finally {
      const data = meetingEndData(props, joinedAt.current, participants.participantCount, snapshot.chat.messages.length);
      props.setEndData(data);
      props.setPhase("end");
      props.onSessionChange?.(null);
      props.onLeave?.();
      props.onEnd?.(data);
    }
  }, [participants.participantCount, props.onEnd, props.onLeave, props.onSessionChange, props.roomId, props.roomName, props.setEndData, props.setPhase, session, snapshot.chat.messages.length]);
  const endForAll = useCallback(async () => {
    await session.endSession();
    await finish();
  }, [finish, session]);

  if (props.phase === "joining") {
    return <JoiningLoadingScreen displayName={props.settings.displayName} message={`Joining ${props.roomName || props.roomId}`} supportingMessages={["Preparing your media...", "Syncing room settings...", "Picking the fastest route...", "Opening the room..."]} />;
  }

  if (snapshot.state === "failed") {
    return (
      <ScrollView contentContainerStyle={styles.errorScreen}>
        <Text style={styles.eyebrow}>Join failed</Text>
        <Text style={styles.title}>{props.roomName || props.roomId}</Text>
        <Text style={styles.body}>{snapshot.failure?.message ?? props.joinError ?? "Unable to join the meeting."}</Text>
        <View style={styles.actionRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry joining" onPress={() => void session.join().catch(props.onJoinFailure)} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Retry</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Return home"
            onPress={() => {
              void session.leave().finally(() => props.onClose?.());
            }}
            style={styles.secondaryButton}
          >
            <Text style={styles.secondaryButtonText}>Home</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  return <MeetingRoom features={props.features} meetingLink={props.meetingLink} onDiagnosticsChange={setMeetingRoomDiagnostics} onEndForAll={props.role === "host" ? endForAll : undefined} onLeave={finish} pickChatAttachments={props.pickChatAttachments} roomName={props.roomName || props.roomId} />;
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

const styles = StyleSheet.create({
  errorScreen: {
    flexGrow: 1,
    backgroundColor: Theme.colors.background,
    paddingHorizontal: Theme.spacing["2xl"],
    paddingTop: Theme.spacing["6xl"],
    paddingBottom: Theme.spacing["3xl"],
    gap: Theme.spacing.lg,
  },
  eyebrow: { ...Theme.typography.eyebrow, color: Theme.colors.primary },
  title: { ...Theme.typography.title, color: Theme.colors.foreground },
  body: { ...Theme.typography.body, color: Theme.colors.mutedForeground },
  actionRow: { flexDirection: "row", gap: Theme.spacing.md },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.primary,
    paddingHorizontal: Theme.spacing.xl,
    paddingVertical: Theme.spacing.md,
  },
  primaryButtonText: { color: Theme.colors.primaryForeground, fontSize: 16, fontWeight: "800" },
  secondaryButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Theme.radius.lg,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.secondary,
    paddingHorizontal: Theme.spacing.xl,
    paddingVertical: Theme.spacing.md,
  },
  secondaryButtonText: { color: Theme.colors.foreground, fontSize: 15, fontWeight: "700" },
});
