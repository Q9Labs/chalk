import { HugeiconsIcon } from "@hugeicons/react-native";
import { RTCView } from "@cloudflare/react-native-webrtc";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { usePreJoinPreview } from "../hooks/usePreJoinPreview";
import { Theme } from "../ui/theme";
import { getIosSimulatorMediaMessage, isIosSimulator } from "../utils/ios-simulator";
import { NativeFaceAvatar } from "./NativeFaceAvatar";

export interface NativeJoinSettings {
  displayName: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
}

export interface NativePreJoinLobbyProps {
  roomName: string;
  role?: "host" | "participant";
  userName?: string;
  initialAudioEnabled?: boolean;
  initialVideoEnabled?: boolean;
  error?: string | null;
  logo?: React.ReactNode;
  joinDisabled?: boolean;
  onJoin: (settings: NativeJoinSettings) => void;
  onCancel?: () => void;
}

export function NativePreJoinLobby({ roomName, role = "participant", userName = role === "host" ? "Host" : "Guest", initialAudioEnabled = true, initialVideoEnabled = true, error, joinDisabled = false, onJoin, onCancel }: NativePreJoinLobbyProps): React.JSX.Element {
  const simulatorMediaDisabled = isIosSimulator();
  const [displayName, setDisplayName] = useState(userName);
  const [audioEnabled, setAudioEnabled] = useState(initialAudioEnabled && !simulatorMediaDisabled);
  const [videoEnabled, setVideoEnabled] = useState(initialVideoEnabled && !simulatorMediaDisabled);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLatchRef = useRef(false);

  const { previewError, previewStream } = usePreJoinPreview(videoEnabled);

  useEffect(() => {
    if (simulatorMediaDisabled) {
      setAudioEnabled(false);
      setVideoEnabled(false);
    }
  }, [simulatorMediaDisabled]);

  useEffect(() => {
    if (!joinDisabled) {
      submitLatchRef.current = false;
      setIsSubmitting(false);
    }
  }, [joinDisabled]);

  const handleJoin = () => {
    if (joinDisabled || isSubmitting || submitLatchRef.current) {
      return;
    }

    submitLatchRef.current = true;
    setIsSubmitting(true);
    onJoin({
      displayName,
      audioEnabled,
      videoEnabled,
    });
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.screen}>
      <View style={styles.content}>
        {/* Top Bar */}
        <View style={styles.topBar}>
          <Pressable onPress={onCancel} style={({ pressed }) => [styles.topIconButton, pressed && styles.topIconButtonPressed]}>
            <HugeiconsIcon icon={ArrowLeft01Icon} size={22} color="white" />
          </Pressable>
          <Text style={styles.brandText}>chalk</Text>
          <View style={styles.topIconButton} />
        </View>

        {/* Hero Preview Box */}
        <View style={styles.previewContainer}>
          <View style={styles.previewSurface}>
            {previewStream && videoEnabled ? (
              <RTCView mirror objectFit="cover" streamURL={previewStream.toURL()} style={styles.previewVideo} zOrder={0} />
            ) : (
              <View style={styles.avatarContainer}>
                <NativeFaceAvatar name={displayName} size={100} textSize={38} />
              </View>
            )}

            <View style={styles.toggleOverlay}>
              <Pressable disabled={simulatorMediaDisabled} onPress={() => setAudioEnabled(!audioEnabled)} style={({ pressed }) => [styles.toggleCircle, !audioEnabled && styles.toggleCircleOff, simulatorMediaDisabled && styles.toggleCircleDisabled, pressed && styles.togglePressed]}>
                <HugeiconsIcon icon={audioEnabled ? Mic01Icon : MicOff01Icon} size={22} color="white" />
              </Pressable>
              <Pressable disabled={simulatorMediaDisabled} onPress={() => setVideoEnabled(!videoEnabled)} style={({ pressed }) => [styles.toggleCircle, !videoEnabled && styles.toggleCircleOff, simulatorMediaDisabled && styles.toggleCircleDisabled, pressed && styles.togglePressed]}>
                <HugeiconsIcon icon={videoEnabled ? Video01Icon : VideoOffIcon} size={22} color="white" />
              </Pressable>
            </View>
          </View>

          {previewError && videoEnabled ? <Text style={styles.previewError}>{previewError}</Text> : null}
          {simulatorMediaDisabled ? <Text style={styles.previewHint}>{getIosSimulatorMediaMessage()}</Text> : null}
        </View>

        {/* Info Area */}
        <View style={styles.infoArea}>
          <Text style={styles.roomName} numberOfLines={1}>
            {roomName}
          </Text>
          <Text style={styles.roleText}>{role === "host" ? "You're the host" : "Ready to join?"}</Text>
        </View>

        {/* Action Area */}
        <View style={styles.footer}>
          <View style={styles.inputCard}>
            <Text style={styles.inputLabel}>Display Name</Text>
            <TextInput onChangeText={setDisplayName} placeholder="Your name" placeholderTextColor="rgba(255,255,255,0.2)" style={styles.nameInput} value={displayName} maxLength={30} returnKeyType="join" onSubmitEditing={handleJoin} />
          </View>

          {error ? <Text style={styles.globalError}>{error}</Text> : null}

          <Pressable disabled={joinDisabled || isSubmitting} onPress={handleJoin} style={[styles.joinButton, (joinDisabled || isSubmitting) && styles.joinButtonDisabled]}>
            <Text style={styles.joinButtonText}>{isSubmitting || joinDisabled ? "Joining..." : "Join Meeting"}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Theme.colors.background,
  },
  content: {
    flex: 1,
    paddingHorizontal: 24,
    paddingTop: Platform.OS === "ios" ? 50 : 20,
    paddingBottom: 40,
  },

  // Top Bar
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: 48,
    marginBottom: 12,
  },
  topIconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
  },
  topIconButtonPressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
  brandText: {
    color: "white",
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.5,
  },

  // Preview Area
  previewContainer: {
    flex: 1,
    maxHeight: 440,
    justifyContent: "center",
    marginBottom: 20,
  },
  previewSurface: {
    width: "100%",
    aspectRatio: 3 / 4,
    backgroundColor: "#0e0e11",
    borderRadius: Theme.radius["2xl"],
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    position: "relative",
  },
  previewVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  avatarContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0c0c0f",
  },
  toggleOverlay: {
    position: "absolute",
    bottom: 20,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 16,
  },
  toggleCircle: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: "rgba(0,0,0,0.55)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
  },
  toggleCircleOff: {
    backgroundColor: "rgba(239,68,68,0.85)",
    borderColor: "rgba(239,68,68,0.85)",
  },
  toggleCircleDisabled: {
    opacity: 0.45,
  },
  togglePressed: {
    opacity: 0.7,
    transform: [{ scale: 0.9 }],
  },
  previewError: {
    color: Theme.colors.error,
    fontSize: 12,
    marginTop: 10,
    textAlign: "center",
    fontWeight: "600",
  },
  previewHint: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    marginTop: 10,
    textAlign: "center",
    lineHeight: 18,
  },

  // Info Area
  infoArea: {
    alignItems: "center",
    marginBottom: 20,
    gap: 3,
  },
  roomName: {
    color: Theme.colors.foreground,
    fontSize: 20,
    fontWeight: "700",
    textAlign: "center",
  },
  roleText: {
    color: Theme.colors.mutedForeground,
    fontSize: 13,
    fontWeight: "500",
  },

  // Footer
  footer: {
    gap: 14,
  },
  inputCard: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 16,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  inputLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  },
  nameInput: {
    color: "white",
    fontSize: 17,
    fontWeight: "600",
    padding: 0,
  },
  joinButton: {
    backgroundColor: Theme.colors.primary,
    height: 56,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  joinButtonDisabled: {
    opacity: 0.6,
  },
  joinButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "700",
  },
  globalError: {
    color: Theme.colors.error,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
});
