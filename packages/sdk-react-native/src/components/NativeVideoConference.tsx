import type { ChalkError } from "@q9labs/chalk-core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useConnection } from "../hooks/useConnection";
import { useChat } from "../hooks/useChat";
import { useParticipants } from "../hooks/useParticipants";
import { useRoom } from "../hooks/useRoom";
import { useSession } from "../context/chalk-native-provider";
import { useTranscripts } from "../hooks/useTranscripts";
import { Theme } from "../ui/theme";
import { NativeEndScreen, type NativeMeetingEndData } from "./NativeEndScreen";
import { NativeJoiningLoadingScreen } from "./NativeJoiningLoadingScreen";
import { NativeMeetingRoom, type NativeMeetingRoomFeatures } from "./NativeMeetingRoom";
import { NativePreJoinLobby, type NativeJoinSettings } from "./NativePreJoinLobby";

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
  initialPhase?: NativeVideoConferencePhase;
  initialJoinSettings?: Partial<NativeJoinSettings>;
  features?: NativeMeetingRoomFeatures;
  onJoin?: (data: NativeMeetingJoinedData) => void;
  onLeave?: () => void;
  onEnd?: (data: NativeMeetingEndData) => void;
  onClose?: () => void;
  onError?: (error: ChalkError) => void;
}

export function NativeVideoConference({
  roomId,
  roomName,
  userName,
  role = "participant",
  autoJoin = false,
  initialPhase,
  initialJoinSettings,
  features,
  onJoin,
  onLeave,
  onEnd,
  onClose,
  onError,
}: NativeVideoConferenceProps): React.JSX.Element {
  const session = useSession();
  const connection = useConnection();
  const room = useRoom();
  const participants = useParticipants();
  const chat = useChat();
  const transcripts = useTranscripts();
  const defaultSettings = useMemo<NativeJoinSettings>(
    () => ({
      displayName: initialJoinSettings?.displayName?.trim() || userName || (role === "host" ? "Host" : "Guest"),
      audioEnabled: initialJoinSettings?.audioEnabled ?? true,
      videoEnabled: initialJoinSettings?.videoEnabled ?? true,
    }),
    [initialJoinSettings?.audioEnabled, initialJoinSettings?.displayName, initialJoinSettings?.videoEnabled, role, userName],
  );
  const [phase, setPhase] = useState<NativeVideoConferencePhase>(() => initialPhase ?? (autoJoin ? "joining" : "lobby"));
  const [joinSettings, setJoinSettings] = useState(defaultSettings);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinNonce, setJoinNonce] = useState(() => (initialPhase === "joining" || autoJoin ? 1 : 0));
  const [endData, setEndData] = useState<NativeMeetingEndData | null>(null);
  const joinedAtRef = useRef<Date | null>(null);
  const didEmitJoinRef = useRef(false);
  const didEmitEndRef = useRef(false);

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

  useEffect(() => {
    const unsubscribe = session.on("error", (error) => {
      onError?.(error);
    });
    return unsubscribe;
  }, [onError, session]);

  useEffect(() => {
    if (phase !== "joining" || joinNonce === 0) {
      return;
    }

    let cancelled = false;
    setJoinError(null);

    void connection
      .join(roomId, {
        userName: joinSettings.displayName,
        role,
        audioEnabled: joinSettings.audioEnabled,
        videoEnabled: joinSettings.videoEnabled,
      })
      .catch((cause) => {
        if (cancelled) {
          return;
        }

        setJoinError(cause instanceof Error ? cause.message : "Unable to join room");
        setPhase("lobby");
      });

    return () => {
      cancelled = true;
    };
  }, [connection, joinNonce, joinSettings.audioEnabled, joinSettings.displayName, joinSettings.videoEnabled, phase, role, roomId]);

  useEffect(() => {
    if (phase !== "joining" || !connection.isConnected) {
      return;
    }

    if (!joinedAtRef.current) {
      joinedAtRef.current = new Date();
    }

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
  }, [connection.isConnected, joinSettings.displayName, onJoin, phase, role, roomId]);

  useEffect(() => {
    if (phase === "meeting" && (room.status === "disconnected" || room.status === "failed")) {
      finalizeMeeting();
    }
  }, [finalizeMeeting, phase, room.status]);

  const startJoin = useCallback(
    (settings: NativeJoinSettings) => {
      didEmitEndRef.current = false;
      setEndData(null);
      setJoinSettings({
        displayName: settings.displayName.trim() || defaultSettings.displayName,
        audioEnabled: settings.audioEnabled,
        videoEnabled: settings.videoEnabled,
      });
      setPhase("joining");
      setJoinNonce((current) => current + 1);
    },
    [defaultSettings.displayName],
  );

  const retryJoin = useCallback(() => {
    setPhase("joining");
    setJoinNonce((current) => current + 1);
  }, []);

  const handleLeave = useCallback(async () => {
    finalizeMeeting();
    await connection.leave();
  }, [connection, finalizeMeeting]);

  const handleEndForAll = useCallback(async () => {
    finalizeMeeting();
    await connection.leave({ endForAll: true });
  }, [connection, finalizeMeeting]);

  const handleRejoin = useCallback(() => {
    didEmitJoinRef.current = false;
    didEmitEndRef.current = false;
    joinedAtRef.current = null;
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
        onCancel={onClose}
        onJoin={startJoin}
        role={role}
        roomName={roomName || roomId}
        userName={joinSettings.displayName}
      />
    );
  }

  if (phase === "joining" && !joinError) {
    return (
      <NativeJoiningLoadingScreen
        displayName={joinSettings.displayName}
        message={`Joining ${roomName || roomId}`}
        supportingMessages={["Preparing your media...", "Syncing room settings...", "Picking the fastest route...", "Opening the room..."]}
      />
    );
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

  return <NativeMeetingRoom features={features} onEndForAll={role === "host" ? handleEndForAll : undefined} onLeave={handleLeave} roomName={roomName || room.roomName || roomId} />;
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
