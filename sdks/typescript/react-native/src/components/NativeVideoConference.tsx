import type { ChalkError } from "../internal/core";
import { useCallback, useMemo, useSyncExternalStore } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useChalkSession, useSession } from "../context/chalk-native-provider";
import { useChat } from "../hooks/useChat";
import { useConnection } from "../hooks/useConnection";
import { useParticipants } from "../hooks/useParticipants";
import { useRoom } from "../hooks/useRoom";
import { useTranscripts } from "../hooks/useTranscripts";
import { Theme } from "../ui/theme";
import { isIosSimulator } from "../utils/ios-simulator";
import { NativeEndScreen } from "./NativeEndScreen";
import { NativeJoiningLoadingScreen } from "./NativeJoiningLoadingScreen";
import { NativeMeetingRoom, type NativeMeetingRoomFeatures } from "./NativeMeetingRoom";
import { NativePreJoinLobby, type NativeJoinSettings } from "./NativePreJoinLobby";
import { NativeVideoConferenceController, type NativeVideoConferenceControllerOptions, type NativeVideoConferenceDiagnosticsSnapshot } from "./native-video-conference-controller";
import type { NativeMeetingEndData } from "./NativeEndScreen";
import type { NativeVideoConferenceCallKitOptions } from "../callkit/resolve-native-video-conference-callkit-options";

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

export type { NativeVideoConferenceDiagnosticsSnapshot } from "./native-video-conference-controller";

export function NativeVideoConference({ roomId, roomName, userName, role = "participant", autoJoin = false, callKit, initialPhase, initialJoinSettings, features, onJoin, onLeave, onEnd, onClose, onError, onDiagnosticsChange }: NativeVideoConferenceProps): React.JSX.Element {
  const simulatorMediaDisabled = isIosSimulator();
  const session = useSession();
  const { telemetry } = useChalkSession();
  const connection = useConnection();
  const room = useRoom();
  const participants = useParticipants();
  const chat = useChat();
  const transcripts = useTranscripts();
  const controller = useMemo<NativeVideoConferenceController>(() => {
    const options: NativeVideoConferenceControllerOptions = {
      autoJoin,
      callKit,
      chatCount: chat.count,
      initialJoinSettings,
      initialPhase,
      onClose,
      onDiagnosticsChange,
      onEnd,
      onError,
      onJoin,
      onLeave,
      participantCount: participants.participantCount,
      role,
      roomId,
      roomName,
      session,
      simulatorMediaDisabled,
      telemetry,
      transcriptCount: transcripts.transcripts.length,
      userName,
    };
    return new NativeVideoConferenceController(options);
  }, [session]);
  const controllerOptions: NativeVideoConferenceControllerOptions = {
    autoJoin,
    callKit,
    chatCount: chat.count,
    initialJoinSettings,
    initialPhase,
    onClose,
    onDiagnosticsChange,
    onEnd,
    onError,
    onJoin,
    onLeave,
    participantCount: participants.participantCount,
    role,
    roomId,
    roomName,
    session,
    simulatorMediaDisabled,
    telemetry,
    transcriptCount: transcripts.transcripts.length,
    userName,
  };
  controller.updateOptions(controllerOptions);

  const subscribe = useCallback((listener: () => void) => controller.subscribe(listener), [callKit, controller, onClose, onDiagnosticsChange, onEnd, onError, onJoin, onLeave, role, roomId, roomName, simulatorMediaDisabled]);
  const controllerSnapshot = useSyncExternalStore(subscribe, controller.getSnapshot, controller.getSnapshot);
  const handleLeave = useCallback(() => controller.disconnect(), [controller]);
  const handleEndForAll = useCallback(() => controller.handleEndForAll(), [controller]);

  if (controllerSnapshot.phase === "lobby") {
    return (
      <NativePreJoinLobby
        error={controllerSnapshot.joinError}
        initialAudioEnabled={controllerSnapshot.joinSettings.audioEnabled}
        initialVideoEnabled={controllerSnapshot.joinSettings.videoEnabled}
        joinDisabled={controllerSnapshot.pendingJoinRequest || connection.isJoining}
        onCancel={onClose}
        onJoin={controller.startJoin}
        role={role}
        roomName={roomName || roomId}
        userName={controllerSnapshot.joinSettings.displayName}
      />
    );
  }

  if (controllerSnapshot.phase === "joining" && !controllerSnapshot.joinError) {
    return <NativeJoiningLoadingScreen displayName={controllerSnapshot.joinSettings.displayName} message={`Joining ${roomName || roomId}`} supportingMessages={["Preparing your media...", "Syncing room settings...", "Picking the fastest route...", "Opening the room..."]} />;
  }

  if (controllerSnapshot.phase === "joining" && controllerSnapshot.joinError) {
    return (
      <ScrollView contentContainerStyle={styles.errorScreen}>
        <Text style={styles.eyebrow}>Join failed</Text>
        <Text style={styles.title}>{roomName || roomId}</Text>
        <Text style={styles.body}>{controllerSnapshot.joinError}</Text>
        <View style={styles.actionRow}>
          <Pressable accessibilityRole="button" accessibilityLabel="Retry joining" onPress={controller.retryJoin} style={styles.primaryButton}>
            <Text style={styles.primaryButtonText}>Retry</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Return home" onPress={onClose} style={styles.secondaryButton}>
            <Text style={styles.secondaryButtonText}>Home</Text>
          </Pressable>
        </View>
      </ScrollView>
    );
  }

  if (controllerSnapshot.phase === "end" && controllerSnapshot.endData) {
    return <NativeEndScreen data={controllerSnapshot.endData} onGoHome={() => onClose?.()} onRejoin={controller.handleRejoin} />;
  }

  return <NativeMeetingRoom features={features} onDiagnosticsChange={controller.setMeetingRoomDiagnostics} onEndForAll={role === "host" ? handleEndForAll : undefined} onLeave={handleLeave} roomName={roomName || room.roomName || roomId} />;
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
