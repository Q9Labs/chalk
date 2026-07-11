import { ChalkErrorClass, type ChalkError, type ChalkSessionDiagnosticsSnapshot } from "../internal/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { nativeCallKit } from "../callkit/native-callkit";
import { resolveNativeVideoConferenceCallKitOptions, type NativeVideoConferenceCallKitOptions } from "../callkit/resolve-native-video-conference-callkit-options";
import { useConnection } from "../hooks/useConnection";
import { useChat } from "../hooks/useChat";
import { useMedia } from "../hooks/useMedia";
import { useParticipants } from "../hooks/useParticipants";
import { useRoom } from "../hooks/useRoom";
import { useChalkSession, useSession } from "../context/chalk-native-provider";
import { useTranscripts } from "../hooks/useTranscripts";
import { Theme } from "../ui/theme";
import { NativeEndScreen, type NativeMeetingEndData } from "./NativeEndScreen";
import { NativeJoiningLoadingScreen } from "./NativeJoiningLoadingScreen";
import { NativeMeetingRoom, type NativeMeetingRoomDiagnosticsSnapshot, type NativeMeetingRoomFeatures } from "./NativeMeetingRoom";
import { NativePreJoinLobby, type NativeJoinSettings } from "./NativePreJoinLobby";
import { resolveNativeJoinDefaults } from "./native-join-defaults";
import { canExecuteNativeJoin, canStartNativeJoin, shouldFailNativeJoinAfterDisconnect, shouldPromoteAfterJoinError } from "../utils/native-join-guard";
import { isIosSimulator } from "../utils/ios-simulator";
import { resolveInitialNativeVideoConferencePhase, shouldResumeNativeMeetingPhase } from "./native-video-conference-phase";

export type NativeVideoConferencePhase = "lobby" | "joining" | "meeting" | "end";

export interface NativeMeetingJoinedData {
  roomId: string;
  displayName: string;
  role: "host" | "participant";
  joinedAt: Date;
}

export interface NativeVideoConferenceProps {
  roomId: string;
  roomName?: string;
  userName?: string;
  role?: "host" | "participant";
  autoJoin?: boolean;
  callKit?: NativeVideoConferenceCallKitOptions | boolean;
  initialPhase?: NativeVideoConferencePhase;
  initialJoinSettings?: Partial<NativeJoinSettings>;
  features?: NativeMeetingRoomFeatures;
  onJoin?: (data: NativeMeetingJoinedData) => void;
  onLeave?: () => void;
  onEnd?: (data: NativeMeetingEndData) => void;
  onClose?: () => void;
  onError?: (error: ChalkError) => void;
  onDiagnosticsChange?: (snapshot: NativeVideoConferenceDiagnosticsSnapshot) => void;
}

export interface NativeVideoConferenceDiagnosticsSnapshot {
  phase: NativeVideoConferencePhase;
  roomId: string;
  roomName: string;
  joinNonce: number;
  pendingJoinRequest: boolean;
  activeJoinNonce: number | null;
  lastJoinError: string | null;
  connectionStatus: string;
  isConnected: boolean;
  isJoining: boolean;
  session: ChalkSessionDiagnosticsSnapshot;
  meetingRoom: NativeMeetingRoomDiagnosticsSnapshot | null;
}

export function NativeVideoConference({ roomId, roomName, userName, role = "participant", autoJoin = false, callKit, initialPhase, initialJoinSettings, features, onJoin, onLeave, onEnd, onClose, onError, onDiagnosticsChange }: NativeVideoConferenceProps): React.JSX.Element {
  const simulatorMediaDisabled = isIosSimulator();
  const session = useSession();
  const { telemetry } = useChalkSession();
  const connection = useConnection();
  const media = useMedia();
  const room = useRoom();
  const participants = useParticipants();
  const chat = useChat();
  const transcripts = useTranscripts();
  const defaultSettings = useMemo<NativeJoinSettings>(
    () =>
      resolveNativeJoinDefaults({
        initialJoinSettings,
        simulatorMediaDisabled,
        userName,
      }),
    [initialJoinSettings?.audioEnabled, initialJoinSettings?.displayName, initialJoinSettings?.videoEnabled, role, simulatorMediaDisabled, userName],
  );
  const [phase, setPhase] = useState<NativeVideoConferencePhase>(() =>
    resolveInitialNativeVideoConferencePhase({
      initialPhase,
      autoJoin,
      isConnected: connection.isConnected,
      activeRoomId: room.roomId,
      roomId,
    }),
  );
  const [joinSettings, setJoinSettings] = useState(defaultSettings);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinNonce, setJoinNonce] = useState(() => (initialPhase === "joining" || autoJoin ? 1 : 0));
  const [endData, setEndData] = useState<NativeMeetingEndData | null>(null);
  const [joinGuardTick, setJoinGuardTick] = useState(0);
  const joinedAtRef = useRef<Date | null>(null);
  const didEmitJoinRef = useRef(false);
  const didEmitEndRef = useRef(false);
  const activeCallKitCallIdRef = useRef<string | null>(null);
  const reportedConnectedCallIdRef = useRef<string | null>(null);
  const startedCallKitJoinNonceRef = useRef<number | null>(null);
  const pendingJoinRequestRef = useRef(initialPhase === "joining" || autoJoin);
  const activeJoinNonceRef = useRef<number | null>(null);
  const activeJoinStartedAtRef = useRef<number | null>(initialPhase === "joining" || autoJoin ? Date.now() : null);
  const [meetingRoomDiagnostics, setMeetingRoomDiagnostics] = useState<NativeMeetingRoomDiagnosticsSnapshot | null>(null);
  const lastDiagnosticsSignatureRef = useRef<string | null>(null);
  const callKitOptions = useMemo(
    () =>
      resolveNativeVideoConferenceCallKitOptions({
        callKit,
        hasVideo: joinSettings.videoEnabled,
        roomId,
        roomName: roomName || roomId,
      }),
    [callKit, joinSettings.videoEnabled, roomId, roomName],
  );

  const buildEndData = useCallback((): NativeMeetingEndData => {
    const joinedAt = joinedAtRef.current ?? new Date();
    return {
      roomId,
      roomName: roomName || room.roomName || roomId,
      durationSeconds: Math.max(0, Math.round((Date.now() - joinedAt.getTime()) / 1000)),
      participantCount: participants.participantCount,
      chatCount: chat.count,
      transcriptCount: transcripts.transcripts.length,
    };
  }, [chat.count, participants.participantCount, room.roomName, roomId, roomName, transcripts.transcripts.length]);

  const promoteToMeeting = useCallback(() => {
    if (!joinedAtRef.current) {
      joinedAtRef.current = new Date();
    }

    pendingJoinRequestRef.current = false;
    activeJoinNonceRef.current = null;
    activeJoinStartedAtRef.current = null;
    setJoinError(null);
    setPhase("meeting");

    if (!didEmitJoinRef.current) {
      didEmitJoinRef.current = true;
      onJoin?.({
        roomId,
        displayName: joinSettings.displayName,
        role,
        joinedAt: joinedAtRef.current,
      });
    }
  }, [joinSettings.displayName, onJoin, role, roomId]);

  const finalizeMeeting = useCallback(() => {
    if (didEmitEndRef.current) {
      return;
    }

    didEmitEndRef.current = true;
    const nextEndData = buildEndData();
    setEndData(nextEndData);
    setPhase("end");
    onLeave?.();
    onEnd?.(nextEndData);
  }, [buildEndData, onEnd, onLeave]);

  const resolveJoinDisconnectMessage = useCallback(() => {
    const diagnostics = session.getDiagnosticsSnapshot();
    const closeReason = diagnostics.websocketLastClose?.reason?.trim();

    if (closeReason) {
      return `Unable to finish joining: ${closeReason}`;
    }

    return "Unable to finish joining the room. Please retry.";
  }, [session]);

  const endCallKitCall = useCallback(async () => {
    if (!activeCallKitCallIdRef.current) {
      return;
    }

    const callUUID = activeCallKitCallIdRef.current;
    activeCallKitCallIdRef.current = null;
    reportedConnectedCallIdRef.current = null;

    try {
      await nativeCallKit.endCall({ callUUID });
    } catch (error) {
      console.warn("Failed to end CallKit call", error);
    }
  }, []);

  const disconnectMeeting = useCallback(
    async (options?: { closeAfterLeave?: boolean }) => {
      pendingJoinRequestRef.current = false;
      activeJoinNonceRef.current = null;
      activeJoinStartedAtRef.current = null;
      await endCallKitCall();

      if (phase === "meeting") {
        finalizeMeeting();
      } else {
        setJoinError(null);
        setPhase("lobby");
      }

      telemetry?.recordSyncFrame({ direction: "client_to_server", frameType: "room.leave" });
      await connection.leave();

      if (options?.closeAfterLeave) {
        onClose?.();
      }
    },
    [connection, endCallKitCall, finalizeMeeting, onClose, phase, telemetry],
  );

  useEffect(() => {
    const unsubscribe = session.on("error", (error) => {
      onError?.(error);
    });
    return unsubscribe;
  }, [onError, session]);

  const diagnosticsSnapshot = useMemo<NativeVideoConferenceDiagnosticsSnapshot>(
    () => ({
      phase,
      roomId,
      roomName: roomName || room.roomName || roomId,
      joinNonce,
      pendingJoinRequest: pendingJoinRequestRef.current,
      activeJoinNonce: activeJoinNonceRef.current,
      lastJoinError: joinError,
      connectionStatus: connection.status,
      isConnected: connection.isConnected,
      isJoining: connection.isJoining,
      session: session.getDiagnosticsSnapshot(),
      meetingRoom: meetingRoomDiagnostics,
    }),
    [connection.isConnected, connection.isJoining, connection.status, joinError, joinNonce, meetingRoomDiagnostics, phase, room.roomName, roomId, roomName, session],
  );

  useEffect(() => {
    if (!onDiagnosticsChange) {
      return;
    }

    const nextSignature = JSON.stringify(diagnosticsSnapshot);
    if (lastDiagnosticsSignatureRef.current === nextSignature) {
      return;
    }

    lastDiagnosticsSignatureRef.current = nextSignature;
    onDiagnosticsChange(diagnosticsSnapshot);
  }, [diagnosticsSnapshot, onDiagnosticsChange]);

  useEffect(() => {
    if (!canExecuteNativeJoin(phase, joinNonce, connection.isJoining, connection.isConnected, pendingJoinRequestRef.current, activeJoinNonceRef.current)) {
      return;
    }

    let cancelled = false;
    activeJoinNonceRef.current = joinNonce;
    setJoinError(null);

    void connection
      .join(roomId, {
        userName: joinSettings.displayName,
        role,
        audioEnabled: simulatorMediaDisabled ? false : joinSettings.audioEnabled,
        videoEnabled: simulatorMediaDisabled ? false : joinSettings.videoEnabled,
      })
      .catch((cause) => {
        if (cancelled) {
          return;
        }

        const roomState = session.room.getState();
        if (
          session.room.getRoom() ||
          shouldPromoteAfterJoinError({
            error: cause,
            expectedRoomId: roomId,
            activeRoomId: session.room.getRoom()?.id ?? null,
            roomStateRoomId: roomState.roomId,
            roomStatus: roomState.status,
          })
        ) {
          promoteToMeeting();
          return;
        }

        activeJoinNonceRef.current = null;
        pendingJoinRequestRef.current = false;
        void endCallKitCall();
        const wrappedError = ChalkErrorClass.wrap(cause);
        setJoinError(wrappedError.message);
        setPhase("lobby");
      });
    telemetry?.recordSyncFrame({ direction: "client_to_server", frameType: "room.join" });

    return () => {
      cancelled = true;
    };
  }, [connection.join, endCallKitCall, joinNonce, joinSettings.audioEnabled, joinSettings.displayName, joinSettings.videoEnabled, phase, promoteToMeeting, role, roomId, session, simulatorMediaDisabled, telemetry]);

  useEffect(() => {
    if (phase !== "joining" || !connection.isConnected) {
      return;
    }

    promoteToMeeting();
  }, [connection.isConnected, phase, promoteToMeeting]);

  useEffect(() => {
    if (phase !== "lobby") {
      return;
    }

    if (
      !shouldResumeNativeMeetingPhase({
        isConnected: connection.isConnected,
        activeRoomId: room.roomId,
        roomId,
      })
    ) {
      return;
    }

    promoteToMeeting();
  }, [connection.isConnected, phase, promoteToMeeting, room.roomId, roomId]);

  useEffect(() => {
    if (phase === "meeting" && (room.status === "disconnected" || room.status === "failed")) {
      finalizeMeeting();
    }
  }, [finalizeMeeting, phase, room.status]);

  useEffect(() => {
    if (phase !== "joining" || !pendingJoinRequestRef.current || activeJoinStartedAtRef.current === null) {
      return;
    }

    const diagnostics = session.getDiagnosticsSnapshot();
    const joinAttemptAgeMs = Date.now() - activeJoinStartedAtRef.current;
    const roomLooksStalled = room.roomId === roomId && (room.status === "disconnected" || room.status === "failed") && !connection.isConnected && !connection.isJoining;

    if (!roomLooksStalled) {
      return;
    }

    const nextCheckInMs = diagnostics.websocketConnectionState === "connecting" ? Math.max(0, 15_000 - joinAttemptAgeMs) : Math.max(0, 3_000 - joinAttemptAgeMs);
    if (nextCheckInMs <= 0) {
      return;
    }

    const timeoutId = setTimeout(
      () => {
        setJoinGuardTick((current) => current + 1);
      },
      Math.min(nextCheckInMs, 1_000),
    );

    return () => {
      clearTimeout(timeoutId);
    };
  }, [connection.isConnected, connection.isJoining, phase, room.roomId, room.status, roomId, session]);

  useEffect(() => {
    const diagnostics = session.getDiagnosticsSnapshot();
    const joinAttemptAgeMs = activeJoinStartedAtRef.current === null ? null : Date.now() - activeJoinStartedAtRef.current;

    if (
      !shouldFailNativeJoinAfterDisconnect({
        phase,
        hasPendingJoinRequest: pendingJoinRequestRef.current,
        activeJoinNonce: activeJoinNonceRef.current,
        isJoining: connection.isJoining,
        isConnected: connection.isConnected,
        expectedRoomId: roomId,
        activeRoomId: room.roomId,
        roomStatus: room.status,
        websocketConnectionState: diagnostics.websocketConnectionState,
        joinAttemptAgeMs,
      })
    ) {
      return;
    }

    pendingJoinRequestRef.current = false;
    activeJoinNonceRef.current = null;
    activeJoinStartedAtRef.current = null;
    void endCallKitCall();
    setJoinError(resolveJoinDisconnectMessage());
    setPhase("lobby");
  }, [connection.isConnected, connection.isJoining, endCallKitCall, joinGuardTick, phase, resolveJoinDisconnectMessage, room.roomId, room.status, roomId, session]);

  useEffect(() => {
    if (!callKitOptions || !nativeCallKit.isSupported) {
      return;
    }

    void nativeCallKit.configure(callKitOptions).catch((error) => {
      console.warn("Failed to configure CallKit", error);
    });
  }, [callKitOptions]);

  useEffect(() => {
    if (!callKitOptions || !nativeCallKit.isSupported || phase !== "joining" || startedCallKitJoinNonceRef.current === joinNonce) {
      return;
    }

    startedCallKitJoinNonceRef.current = joinNonce;
    let cancelled = false;

    void nativeCallKit
      .startCall(callKitOptions)
      .then((result) => {
        if (cancelled || !result?.callUUID) {
          return;
        }

        activeCallKitCallIdRef.current = result.callUUID;
        reportedConnectedCallIdRef.current = null;
      })
      .catch((error) => {
        console.warn("Failed to start CallKit call", error);
      });

    return () => {
      cancelled = true;
    };
  }, [callKitOptions, joinNonce, phase]);

  useEffect(() => {
    if (!callKitOptions || !nativeCallKit.isSupported || phase !== "meeting" || !activeCallKitCallIdRef.current || reportedConnectedCallIdRef.current === activeCallKitCallIdRef.current) {
      return;
    }

    const callUUID = activeCallKitCallIdRef.current;
    reportedConnectedCallIdRef.current = callUUID;

    void nativeCallKit.reportConnected({ callUUID }).catch((error) => {
      console.warn("Failed to report CallKit connection", error);
    });
  }, [callKitOptions, phase]);

  useEffect(() => {
    if ((phase !== "lobby" && phase !== "end") || !activeCallKitCallIdRef.current) {
      return;
    }

    void endCallKitCall();
  }, [endCallKitCall, phase]);

  useEffect(() => {
    if (!callKitOptions || !nativeCallKit.isSupported) {
      return;
    }

    const subscription = nativeCallKit.addListener((event) => {
      if (event.type === "endCallAction") {
        void disconnectMeeting({ closeAfterLeave: phase !== "meeting" });
        return;
      }

      if (event.type === "setMutedCallAction" && event.muted === media.isAudioEnabled) {
        void media.toggleAudio().catch((error) => {
          console.warn("Failed to sync CallKit mute state", error);
        });
      }
    });

    return () => {
      subscription.remove();
    };
  }, [callKitOptions, disconnectMeeting, media, phase]);

  useEffect(
    () => () => {
      void endCallKitCall();
    },
    [endCallKitCall],
  );

  const startJoin = useCallback(
    (settings: NativeJoinSettings) => {
      if (!canStartNativeJoin(phase, connection.isJoining, connection.isConnected, pendingJoinRequestRef.current)) {
        return;
      }

      pendingJoinRequestRef.current = true;
      activeJoinStartedAtRef.current = Date.now();
      didEmitEndRef.current = false;
      setEndData(null);
      setJoinSettings({
        displayName: settings.displayName.trim() || defaultSettings.displayName,
        audioEnabled: simulatorMediaDisabled ? false : settings.audioEnabled,
        videoEnabled: simulatorMediaDisabled ? false : settings.videoEnabled,
      });
      setPhase("joining");
      setJoinNonce((current) => current + 1);
    },
    [connection.isConnected, connection.isJoining, defaultSettings.displayName, phase, simulatorMediaDisabled],
  );

  const retryJoin = useCallback(() => {
    if (connection.isJoining || connection.isConnected || pendingJoinRequestRef.current) {
      return;
    }

    pendingJoinRequestRef.current = true;
    activeJoinStartedAtRef.current = Date.now();
    setPhase("joining");
    setJoinNonce((current) => current + 1);
  }, [connection.isConnected, connection.isJoining]);

  const handleLeave = useCallback(async () => {
    await disconnectMeeting();
  }, [disconnectMeeting]);

  const handleEndForAll = useCallback(async () => {
    pendingJoinRequestRef.current = false;
    activeJoinStartedAtRef.current = null;
    await endCallKitCall();
    finalizeMeeting();
    await connection.leave({ endForAll: true });
  }, [connection, endCallKitCall, finalizeMeeting]);

  const handleRejoin = useCallback(() => {
    pendingJoinRequestRef.current = true;
    activeJoinNonceRef.current = null;
    activeJoinStartedAtRef.current = Date.now();
    didEmitJoinRef.current = false;
    didEmitEndRef.current = false;
    joinedAtRef.current = null;
    startedCallKitJoinNonceRef.current = null;
    setEndData(null);
    setPhase("joining");
    setJoinNonce((current) => current + 1);
  }, []);

  if (phase === "lobby") {
    return (
      <NativePreJoinLobby
        error={joinError}
        initialAudioEnabled={joinSettings.audioEnabled}
        initialVideoEnabled={joinSettings.videoEnabled}
        joinDisabled={pendingJoinRequestRef.current || connection.isJoining}
        onCancel={onClose}
        onJoin={startJoin}
        role={role}
        roomName={roomName || roomId}
        userName={joinSettings.displayName}
      />
    );
  }

  if (phase === "joining" && !joinError) {
    return <NativeJoiningLoadingScreen displayName={joinSettings.displayName} message={`Joining ${roomName || roomId}`} supportingMessages={["Preparing your media...", "Syncing room settings...", "Picking the fastest route...", "Opening the room..."]} />;
  }

  if (phase === "joining" && joinError) {
    return (
      <ScrollView contentContainerStyle={styles.errorScreen}>
        <Text style={styles.eyebrow}>Join failed</Text>
        <Text style={styles.title}>{roomName || roomId}</Text>
        <Text style={styles.body}>{joinError}</Text>
        <View style={styles.actionRow}>
          <Pressable onPress={retryJoin} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Retry</Text>
          </Pressable>
          <Pressable onPress={onClose} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Home</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  if (phase === "end" && endData) {
    return <NativeEndScreen data={endData} onGoHome={() => onClose?.()} onRejoin={handleRejoin} />;
  }

  return <NativeMeetingRoom features={features} onDiagnosticsChange={setMeetingRoomDiagnostics} onEndForAll={role === "host" ? handleEndForAll : undefined} onLeave={handleLeave} roomName={roomName || room.roomName || roomId} />;
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
  eyebrow: {
    ...Theme.typography.eyebrow,
    color: Theme.colors.primary,
  },
  title: {
    ...Theme.typography.title,
    color: Theme.colors.foreground,
  },
  body: {
    ...Theme.typography.body,
    color: Theme.colors.mutedForeground,
  },
  actionRow: {
    flexDirection: "row",
    gap: Theme.spacing.md,
  },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.primary,
    paddingHorizontal: Theme.spacing.xl,
    paddingVertical: Theme.spacing.md,
  },
  primaryButtonText: {
    color: Theme.colors.primaryForeground,
    fontSize: 16,
    fontWeight: "800",
  },
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
  secondaryButtonText: {
    color: Theme.colors.foreground,
    fontSize: 15,
    fontWeight: "700",
  },
});
