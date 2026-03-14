import { ChalkNativeProvider, useConnection, useParticipants, useSession } from "@q9labs/chalk-react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { 
  Mic01Icon, 
  MicOff01Icon, 
  VideoIcon, 
  VideoOffIcon, 
  ComputerScreenShareIcon, 
  WavingHand01Icon, 
  ThumbsUpIcon, 
  Home01Icon, 
  Cancel01Icon 
} from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { JoiningLoadingScreen } from "../components/JoiningLoadingScreen";
import { clearJoinContext, getApiUrl, getHostTokenProvider, getJoinAccessToken, getWsUrl, type RoomRoute } from "../lib/chalk";
import { Theme } from "../lib/theme";

export interface RoomScreenProps {
  route: RoomRoute;
  onBack: () => void;
}

export function RoomScreen({ route, onBack }: RoomScreenProps): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const wsUrl = useMemo(() => getWsUrl(apiUrl), [apiUrl]);
  const tokenProvider = useMemo(() => {
    if (route.joinToken) {
      const joinToken = route.joinToken;
      return async () => getJoinAccessToken(apiUrl, joinToken);
    }

    return getHostTokenProvider(apiUrl) ?? undefined;
  }, [apiUrl, route.joinToken]);

  return (
    <ChalkNativeProvider apiUrl={apiUrl} wsUrl={wsUrl} debug tokenProvider={tokenProvider}>
      <MeetingRuntime route={route} onBack={onBack} />
    </ChalkNativeProvider>
  );
}

function MeetingRuntime({ route, onBack }: { route: RoomRoute; onBack: () => void }): React.JSX.Element {
  const session = useSession();
  const { join, leave, isConnected, isJoining, status } = useConnection();
  const { participants, localParticipant, activeSpeaker } = useParticipants();
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joinAttempt, setJoinAttempt] = useState(0);
  const [isAudioBusy, setIsAudioBusy] = useState(false);
  const [isVideoBusy, setIsVideoBusy] = useState(false);
  const [mediaState, setMediaState] = useState(() => session.media.getState());
  const initialAttemptDone = useRef(false);

  useEffect(() => session.media.subscribe(setMediaState), [session]);

  useEffect(() => {
    if (initialAttemptDone.current && joinAttempt === 0) {
      return;
    }

    initialAttemptDone.current = true;
    let cancelled = false;

    void join(route.roomId, {
      userName: route.joinDraft.displayName,
      role: route.role,
      audioEnabled: route.joinDraft.audioEnabled,
      videoEnabled: route.joinDraft.videoEnabled,
    }).catch((error) => {
      if (!cancelled) {
        setJoinError(error instanceof Error ? error.message : String(error));
      }
    });

    return () => {
      cancelled = true;
    };
  }, [join, joinAttempt, route.joinDraft.audioEnabled, route.joinDraft.displayName, route.joinDraft.videoEnabled, route.role, route.roomId]);

  const stageParticipant = activeSpeaker ?? localParticipant ?? participants[0] ?? null;
  const stageName = stageParticipant?.displayName || route.joinDraft.displayName;
  const stageInitial = stageName.trim().charAt(0).toUpperCase() || "C";
  const isMuted = mediaState.isAudioEnabled === false;
  const isCameraOff = mediaState.isVideoEnabled === false;
  const handRaised = localParticipant?.handRaised ?? false;

  const handleRetry = () => {
    setJoinError(null);
    setJoinAttempt((current) => current + 1);
  };

  const handleLeave = async () => {
    await leave();
    await clearJoinContext();
    onBack();
  };

  const handleToggleAudio = async () => {
    if (isAudioBusy) {
      return;
    }

    setIsAudioBusy(true);
    try {
      await session.media.toggleAudio();
    } finally {
      setIsAudioBusy(false);
    }
  };

  const handleToggleVideo = async () => {
    if (isVideoBusy) {
      return;
    }

    setIsVideoBusy(true);
    try {
      await session.media.toggleVideo();
    } finally {
      setIsVideoBusy(false);
    }
  };

  const handleToggleHand = () => {
    if (handRaised) {
      session.interactions.lowerHand();
      return;
    }

    session.interactions.raiseHand();
  };

  if (!isConnected) {
    if (!joinError) {
      return (
        <JoiningLoadingScreen
          displayName={route.joinDraft.displayName}
          message="Joining room..."
          supportingMessages={[
            "Checking your camera and mic...",
            "Syncing room settings...",
            "Testing your connection...",
            "Preparing your preview...",
            "Opening a low-latency route...",
            "Choosing the fastest route...",
            "Almost there...",
          ]}
        />
      );
    }

    return (
      <ScrollView contentContainerStyle={styles.connectingScreen}>
        <Text style={styles.eyebrow}>Connecting</Text>
        <Text style={styles.title}>{route.roomName || route.roomId}</Text>
        <Text style={styles.body}>
          Joining with {route.joinDraft.displayName}, microphone {route.joinDraft.audioEnabled ? "on" : "off"}, camera {route.joinDraft.videoEnabled ? "on" : "off"}.
        </Text>

        <View style={styles.connectingCard}>
          <ActivityIndicator color={Theme.colors.primary} />
          <Text style={styles.statusLine}>Role: {route.role}</Text>
          <Text style={styles.statusLine}>Status: {isJoining ? "joining" : status}</Text>
          <Text style={styles.statusLine}>Source: {route.source}</Text>
        </View>

        <View style={styles.connectingCard}>
          <Text style={styles.errorTitle}>Join failed</Text>
          <Text style={styles.errorBody}>{joinError}</Text>
          <View style={styles.connectingActions}>
            <Pressable onPress={handleRetry} style={styles.primaryButton}>
              <Text style={styles.primaryButtonText}>Retry join</Text>
            </Pressable>
            <Pressable onPress={onBack} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Back home</Text>
            </Pressable>
          </View>
        </View>
      </ScrollView>
    );
  }

  return (
    <View style={styles.roomScreen}>
      <View style={styles.stageFrame}>
        <View style={styles.stageSurface}>
          <View style={styles.stageCenter}>
            <View style={styles.avatarOrb}>
              <View style={styles.eyesRow}>
                <View style={styles.eyeDot} />
                <View style={styles.eyeDot} />
              </View>
              <Text style={styles.avatarInitial}>{stageInitial}</Text>
            </View>
          </View>

          <View style={styles.selfPill}>
            <View style={styles.selfAvatar}>
              <View style={styles.selfAvatarEyes}>
                <View style={styles.selfAvatarEye} />
                <View style={styles.selfAvatarEye} />
              </View>
              <Text style={styles.selfAvatarText}>{stageInitial}</Text>
            </View>
            <Text style={styles.selfPillName}>{localParticipant?.role === "host" || route.role === "host" ? "Host" : localParticipant?.displayName || route.joinDraft.displayName}</Text>
            {isMuted && (
              <View style={styles.micOffIndicator}>
                <HugeiconsIcon icon={MicOff01Icon} size={12} color="white" />
              </View>
            )}
          </View>
        </View>
      </View>

      <View style={styles.bottomDock}>
        <View style={styles.controlPill}>
          <Pressable onPress={handleToggleAudio} style={[styles.controlButton, isMuted && styles.controlButtonDanger]}>
            <HugeiconsIcon icon={isMuted ? MicOff01Icon : Mic01Icon} size={24} color="white" />
          </Pressable>
          <Pressable onPress={handleToggleVideo} style={[styles.controlButton, isCameraOff && styles.controlButtonDanger]}>
            <HugeiconsIcon icon={isCameraOff ? VideoOffIcon : VideoIcon} size={24} color="white" />
          </Pressable>
        </View>

        <View style={styles.controlPill}>
          <Pressable style={styles.controlButton}>
            <HugeiconsIcon icon={ComputerScreenShareIcon} size={24} color="white" />
          </Pressable>
          <Pressable onPress={handleToggleHand} style={[styles.controlButton, handRaised && styles.controlButtonActive]}>
            <HugeiconsIcon icon={WavingHand01Icon} size={24} color={handRaised ? Theme.colors.primary : "white"} />
          </Pressable>
          <Pressable style={styles.controlButton}>
            <HugeiconsIcon icon={ThumbsUpIcon} size={24} color="#facc15" />
          </Pressable>
        </View>

        <View style={styles.controlPill}>
          <Pressable onPress={onBack} style={styles.controlButton}>
            <HugeiconsIcon icon={Home01Icon} size={24} color="white" />
          </Pressable>
          <Pressable onPress={handleLeave} style={[styles.controlButton, styles.controlButtonEndCall]}>
            <HugeiconsIcon icon={Cancel01Icon} size={24} color="white" />
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  connectingScreen: {
    flexGrow: 1,
    backgroundColor: Theme.colors.background,
    paddingHorizontal: Theme.spacing["2xl"],
    paddingTop: Theme.spacing["6xl"],
    paddingBottom: Theme.spacing["3xl"],
    gap: Theme.spacing.lg,
  },
  roomScreen: {
    flex: 1,
    backgroundColor: "#000000",
    paddingHorizontal: 8,
    paddingTop: 8,
    paddingBottom: 24,
  },
  stageFrame: {
    flex: 1,
    borderRadius: 36,
    overflow: "hidden",
    backgroundColor: "#101314",
  },
  stageSurface: {
    flex: 1,
    backgroundColor: "#26c25b",
    padding: 16,
  },
  stageCenter: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarOrb: {
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    gap: 4,
  },
  eyesRow: {
    flexDirection: "row",
    gap: 44,
    marginBottom: 4,
  },
  eyeDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#ffffff",
  },
  avatarInitial: {
    color: "#ffffff",
    fontSize: 48,
    fontWeight: "400",
  },
  selfPill: {
    position: "absolute",
    left: 16,
    bottom: 16,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingLeft: 6,
    paddingRight: 10,
    paddingVertical: 6,
    borderRadius: 24,
    backgroundColor: "rgba(0,0,0,0.7)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  selfAvatar: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: "rgba(61, 224, 120, 0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  selfAvatarEyes: {
    flexDirection: "row",
    gap: 8,
    marginBottom: 1,
  },
  selfAvatarEye: {
    width: 4,
    height: 4,
    borderRadius: 2,
    backgroundColor: "white",
  },
  selfAvatarText: {
    color: "#ffffff",
    fontSize: 10,
    fontWeight: "700",
  },
  selfPillName: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  micOffIndicator: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#ef4444",
    alignItems: "center",
    justifyContent: "center",
  },
  bottomDock: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: 12,
    gap: 8,
  },
  controlPill: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#111111",
    borderRadius: 28,
    padding: 4,
    gap: 4,
  },
  controlButton: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  controlButtonActive: {
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  controlButtonDanger: {
    backgroundColor: "#ef4444",
  },
  controlButtonEndCall: {
    backgroundColor: "#ef4444",
    width: 64,
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
  connectingCard: {
    backgroundColor: Theme.colors.card,
    borderRadius: Theme.radius["2xl"],
    padding: Theme.spacing.xl,
    gap: Theme.spacing.md,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  statusLine: {
    color: Theme.colors.foreground,
    fontSize: 14,
    fontWeight: "600",
  },
  sectionTitle: {
    ...Theme.typography.subheading,
    color: Theme.colors.foreground,
  },
  errorTitle: {
    ...Theme.typography.subheading,
    color: Theme.colors.error,
  },
  errorBody: {
    ...Theme.typography.body,
    color: Theme.colors.destructiveForeground,
  },
  connectingActions: {
    flexDirection: "row",
    gap: Theme.spacing.sm,
  },
  primaryButton: {
    flex: 1,
    backgroundColor: Theme.colors.primary,
    borderRadius: Theme.radius.full,
    paddingVertical: Theme.spacing.md,
    alignItems: "center",
  },
  primaryButtonText: {
    color: Theme.colors.primaryForeground,
    fontWeight: "700",
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: Theme.colors.secondary,
    borderRadius: Theme.radius.full,
    paddingVertical: Theme.spacing.md,
    alignItems: "center",
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  secondaryButtonText: {
    color: Theme.colors.secondaryForeground,
    fontWeight: "700",
  },
});
