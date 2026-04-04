import { HugeiconsIcon } from "@hugeicons/react-native";
import { RTCView } from "@cloudflare/react-native-webrtc";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import UserIcon from "@hugeicons/core-free-icons/dist/esm/UserIcon";
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

export function NativePreJoinLobby({ roomName, role = "participant", userName = role === "host" ? "Host" : "Guest", initialAudioEnabled = false, initialVideoEnabled = false, error, joinDisabled = false, onJoin, onCancel }: NativePreJoinLobbyProps): React.JSX.Element {
  const simulatorMediaDisabled = isIosSimulator();
  const [displayName, setDisplayName] = useState(userName);
  const [audioEnabled, setAudioEnabled] = useState(initialAudioEnabled && !simulatorMediaDisabled);
  const [videoEnabled, setVideoEnabled] = useState(initialVideoEnabled && !simulatorMediaDisabled);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLatchRef = useRef(false);

  const [isInputFocused, setIsInputFocused] = useState(false);

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
        {/* Hero Preview Box */}
        <View style={styles.previewContainer}>
          <View style={styles.previewSurface}>
            {previewStream && videoEnabled ? (
              <RTCView mirror objectFit="cover" streamURL={previewStream.toURL()} style={styles.previewVideo} zOrder={0} />
            ) : (
              <View style={styles.avatarContainer}>
                <NativeFaceAvatar name={displayName} size={140} textSize={52} />
              </View>
            )}

            {/* Floating Back Button */}
            <Pressable onPress={onCancel} style={({ pressed }) => [styles.floatingBack, pressed && styles.topIconButtonPressed]}>
              <HugeiconsIcon icon={ArrowLeft01Icon} size={22} color="white" />
            </Pressable>
          </View>

          {previewError && videoEnabled ? <Text style={styles.previewError}>{previewError}</Text> : null}
          {simulatorMediaDisabled ? <Text style={styles.previewHint}>{getIosSimulatorMediaMessage()}</Text> : null}
        </View>

        {/* Bottom Sheet UI */}
        <View style={styles.sheetContainer}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text style={styles.roomName} numberOfLines={1}>
              {roomName}
            </Text>
          </View>

          <View style={[styles.inputCard, isInputFocused && styles.inputCardFocused]}>
            <HugeiconsIcon icon={UserIcon} size={18} color={isInputFocused ? Theme.colors.primary : "rgba(255,255,255,0.4)"} style={styles.inputIcon} />
            <TextInput onChangeText={setDisplayName} onFocus={() => setIsInputFocused(true)} onBlur={() => setIsInputFocused(false)} placeholder="Enter your name" placeholderTextColor="rgba(255,255,255,0.25)" style={styles.nameInput} value={displayName} maxLength={30} returnKeyType="join" onSubmitEditing={handleJoin} />
          </View>

          <View style={styles.mediaRow}>
            <Pressable disabled={simulatorMediaDisabled} onPress={() => setAudioEnabled(!audioEnabled)} style={({ pressed }) => [styles.controlCircle, !audioEnabled && styles.toggleCircleOff, simulatorMediaDisabled && styles.toggleCircleDisabled, pressed && styles.togglePressed]}>
              <HugeiconsIcon icon={audioEnabled ? Mic01Icon : MicOff01Icon} size={24} color="white" />
            </Pressable>
            <Pressable disabled={simulatorMediaDisabled} onPress={() => setVideoEnabled(!videoEnabled)} style={({ pressed }) => [styles.controlCircle, !videoEnabled && styles.toggleCircleOff, simulatorMediaDisabled && styles.toggleCircleDisabled, pressed && styles.togglePressed]}>
              <HugeiconsIcon icon={videoEnabled ? Video01Icon : VideoOffIcon} size={24} color="white" />
            </Pressable>
          </View>

          {error ? <Text style={styles.globalError}>{error}</Text> : null}

          <Pressable disabled={joinDisabled || isSubmitting} onPress={handleJoin} style={({ pressed }) => [styles.joinButton, (joinDisabled || isSubmitting) && styles.joinButtonDisabled, !displayName && styles.joinButtonDimmed, pressed && styles.togglePressed]}>
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
  },
  floatingBack: {
    position: "absolute",
    top: Platform.OS === "ios" ? 24 : 20,
    left: 20,
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  previewContainer: {
    flex: 1,
    justifyContent: "center",
    paddingTop: Platform.OS === "ios" ? 10 : 0,
    marginBottom: 0, // Removed gap to meet the sheet
  },
  previewSurface: {
    width: "100%",
    aspectRatio: 0.72,
    backgroundColor: "#0e0e11",
    borderRadius: 32,
    alignSelf: "center",
    overflow: "hidden",
    position: "relative",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
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
    paddingHorizontal: 24,
  },
  previewHint: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    marginTop: 10,
    textAlign: "center",
    lineHeight: 18,
    paddingHorizontal: 24,
  },

  // Sheet Area
  sheetContainer: {
    backgroundColor: "#16161a",
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: Platform.OS === "ios" ? 44 : 32,
    gap: 20,
    borderTopWidth: 1,
    borderColor: "rgba(255,255,255,0.08)", // Sharper top edge highlight
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 20,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignSelf: "center",
    marginBottom: 8,
  },
  sheetHeader: {
    alignItems: "center",
    marginBottom: 4,
  },
  roomName: {
    color: Theme.colors.foreground,
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.6,
  },
  inputCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 18,
    paddingHorizontal: 16,
    height: 56,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  inputCardFocused: {
    borderColor: Theme.colors.primary,
    backgroundColor: "rgba(27, 182, 166, 0.04)",
  },
  inputIcon: {
    marginRight: 24,
  },
  nameInput: {
    flex: 1,
    color: "white",
    fontSize: 16,
    fontWeight: "600",
    padding: 0,
  },
  mediaRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 20,
  },
  controlCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  toggleCircleOff: {
    backgroundColor: "#ea4335",
    borderColor: "#ea4335",
  },
  toggleCircleDisabled: {
    opacity: 0.45,
  },
  joinButton: {
    width: "100%",
    backgroundColor: Theme.colors.primary,
    height: 58,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 6,
  },
  joinButtonDimmed: {
    opacity: 0.5,
    backgroundColor: "rgba(255,255,255,0.1)",
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
  topIconButtonPressed: {
    opacity: 0.6,
    transform: [{ scale: 0.92 }],
  },
});
