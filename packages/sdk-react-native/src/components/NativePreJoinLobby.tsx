import { HugeiconsIcon } from "@hugeicons/react-native";
import { RTCView } from "@cloudflare/react-native-webrtc";
import { Mic01Icon, MicOff01Icon, Video01Icon, VideoOffIcon, ArrowLeft01Icon, Settings01Icon } from "@hugeicons/core-free-icons";
import { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { usePreJoinPreview } from "../hooks/usePreJoinPreview";
import { Theme } from "../ui/theme";
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
  const [displayName, setDisplayName] = useState(userName);
  const [audioEnabled, setAudioEnabled] = useState(initialAudioEnabled);
  const [videoEnabled, setVideoEnabled] = useState(initialVideoEnabled);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLatchRef = useRef(false);

  const { previewError, previewStream } = usePreJoinPreview(videoEnabled);

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
        {/* Ultra-Clean Top Bar */}
        <View style={styles.topBar}>
          <Pressable onPress={onCancel} style={styles.topIconButton}>
            <HugeiconsIcon icon={ArrowLeft01Icon} size={24} color="white" />
          </Pressable>
          <Text style={styles.brandText}>chalk</Text>
          <Pressable style={styles.topIconButton}>
            <HugeiconsIcon icon={Settings01Icon} size={22} color="white" />
          </Pressable>
        </View>

        {/* Hero Preview Box */}
        <View style={styles.previewContainer}>
          <View style={styles.previewSurface}>
            {previewStream && videoEnabled ? (
              <RTCView mirror objectFit="cover" streamURL={previewStream.toURL()} style={styles.previewVideo} zOrder={0} />
            ) : (
              <View style={styles.avatarContainer}>
                <NativeFaceAvatar name={displayName} size={140} />
              </View>
            )}

            <View style={styles.toggleOverlay}>
              <Pressable onPress={() => setAudioEnabled(!audioEnabled)} style={[styles.toggleCircle, !audioEnabled && styles.toggleCircleOff]}>
                <HugeiconsIcon icon={audioEnabled ? Mic01Icon : MicOff01Icon} size={24} color="white" />
              </Pressable>
              <Pressable onPress={() => setVideoEnabled(!videoEnabled)} style={[styles.toggleCircle, !videoEnabled && styles.toggleCircleOff]}>
                <HugeiconsIcon icon={videoEnabled ? Video01Icon : VideoOffIcon} size={24} color="white" />
              </Pressable>
            </View>
          </View>

          {previewError && videoEnabled ? <Text style={styles.previewError}>{previewError}</Text> : null}
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
    height: 56,
    marginBottom: 16,
  },
  topIconButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
  },
  brandText: {
    color: "white",
    fontSize: 20,
    fontWeight: "800",
    letterSpacing: -0.5,
  },

  // Preview Area
  previewContainer: {
    flex: 1,
    maxHeight: 480,
    justifyContent: "center",
    marginBottom: 24,
  },
  previewSurface: {
    width: "100%",
    aspectRatio: 3 / 4,
    backgroundColor: "#111114",
    borderRadius: 36,
    overflow: "hidden",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    position: "relative",
  },
  previewVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  avatarContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0f0f12",
  },
  toggleOverlay: {
    position: "absolute",
    bottom: 24,
    left: 0,
    right: 0,
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
  },
  toggleCircle: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: "rgba(0,0,0,0.6)",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.15)",
    alignItems: "center",
    justifyContent: "center",
  },
  toggleCircleOff: {
    backgroundColor: Theme.colors.error,
    borderColor: Theme.colors.error,
  },
  previewError: {
    color: Theme.colors.error,
    fontSize: 12,
    marginTop: 12,
    textAlign: "center",
    fontWeight: "600",
  },

  // Info Area
  infoArea: {
    alignItems: "center",
    marginBottom: 24,
    gap: 4,
  },
  roomName: {
    color: Theme.colors.foreground,
    fontSize: 22,
    fontWeight: "700",
    textAlign: "center",
  },
  roleText: {
    color: Theme.colors.mutedForeground,
    fontSize: 14,
    fontWeight: "500",
  },

  // Footer
  footer: {
    gap: 16,
  },
  inputCard: {
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 20,
    padding: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
  },
  inputLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 11,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 1,
    marginBottom: 6,
  },
  nameInput: {
    color: "white",
    fontSize: 18,
    fontWeight: "600",
    padding: 0,
  },
  joinButton: {
    backgroundColor: Theme.colors.primary,
    height: 64,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 15,
    elevation: 8,
  },
  joinButtonDisabled: {
    opacity: 0.7,
  },
  joinButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "800",
  },
  globalError: {
    color: Theme.colors.error,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
});
