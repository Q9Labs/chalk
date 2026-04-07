import { RTCView } from "@cloudflare/react-native-webrtc";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import UserIcon from "@hugeicons/core-free-icons/dist/esm/UserIcon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";
import { Theme } from "../ui/theme";
import { getIosSimulatorMediaMessage } from "../utils/ios-simulator";
import { NativeFaceAvatar } from "./NativeFaceAvatar";
import type { NativePreJoinLobbyProps } from "./NativePreJoinLobby";
import { useNativePreJoinLobbyController } from "./native-prejoin/useNativePreJoinLobbyController";

export function NativePreJoinLobbyIosPad({ roomName, error, joinDisabled = false, onCancel, ...props }: NativePreJoinLobbyProps): React.JSX.Element {
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const controller = useNativePreJoinLobbyController({ ...props, joinDisabled });

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.screen}>
      <View style={[styles.content, isLandscape && styles.contentLandscape]}>
        <View style={[styles.previewContainer, isLandscape && styles.previewContainerLandscape]}>
          <View style={[styles.previewSurface, isLandscape && styles.previewSurfaceLandscape]}>
            {controller.previewStream && controller.videoEnabled ? (
              <RTCView mirror objectFit="cover" streamURL={controller.previewStream.toURL()} style={styles.previewVideo} zOrder={0} />
            ) : (
              <View style={styles.avatarContainer}>
                <NativeFaceAvatar name={controller.displayName} size={140} textSize={52} />
              </View>
            )}

            <Pressable onPress={onCancel} style={({ pressed }) => [styles.floatingBack, pressed && styles.topIconButtonPressed]}>
              <HugeiconsIcon icon={ArrowLeft01Icon} size={22} color="white" />
            </Pressable>
          </View>

          {controller.previewError && controller.videoEnabled ? <Text style={styles.previewError}>{controller.previewError}</Text> : null}
          {controller.simulatorMediaDisabled ? <Text style={styles.previewHint}>{getIosSimulatorMediaMessage()}</Text> : null}
        </View>

        <View style={[styles.sheetContainer, isLandscape && styles.sheetContainerLandscape]}>
          {!isLandscape && <View style={styles.sheetHandle} />}
          <View style={styles.sheetHeader}>
            <Text style={styles.roomName} numberOfLines={1}>
              {roomName}
            </Text>
          </View>

          <View style={[styles.inputCard, controller.isInputFocused && styles.inputCardFocused]}>
            <HugeiconsIcon icon={UserIcon} size={18} color={controller.isInputFocused ? Theme.colors.primary : "rgba(255,255,255,0.4)"} style={styles.inputIcon} />
            <TextInput
              onChangeText={controller.setDisplayName}
              onFocus={() => controller.setInputFocused(true)}
              onBlur={() => controller.setInputFocused(false)}
              placeholder="Enter your name"
              placeholderTextColor="rgba(255,255,255,0.25)"
              style={styles.nameInput}
              value={controller.displayName}
              maxLength={30}
              returnKeyType="join"
              onSubmitEditing={controller.handleJoin}
            />
          </View>

          <View style={styles.mediaRow}>
            <Pressable disabled={controller.simulatorMediaDisabled} onPress={controller.toggleAudio} style={({ pressed }) => [styles.controlCircle, !controller.audioEnabled && styles.toggleCircleOff, controller.simulatorMediaDisabled && styles.toggleCircleDisabled, pressed && styles.togglePressed]}>
              <HugeiconsIcon icon={controller.audioEnabled ? Mic01Icon : MicOff01Icon} size={24} color="white" />
            </Pressable>
            <Pressable disabled={controller.simulatorMediaDisabled} onPress={controller.toggleVideo} style={({ pressed }) => [styles.controlCircle, !controller.videoEnabled && styles.toggleCircleOff, controller.simulatorMediaDisabled && styles.toggleCircleDisabled, pressed && styles.togglePressed]}>
              <HugeiconsIcon icon={controller.videoEnabled ? Video01Icon : VideoOffIcon} size={24} color="white" />
            </Pressable>
          </View>

          {error ? <Text style={styles.globalError}>{error}</Text> : null}

          <Pressable
            disabled={joinDisabled || controller.isSubmitting}
            onPress={controller.handleJoin}
            style={({ pressed }) => [styles.joinButton, (joinDisabled || controller.isSubmitting) && styles.joinButtonDisabled, !controller.displayName && styles.joinButtonDimmed, pressed && styles.togglePressed]}
          >
            <Text style={styles.joinButtonText}>{controller.isSubmitting || joinDisabled ? "Joining..." : "Join Meeting"}</Text>
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
  contentLandscape: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 40,
    gap: 40,
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
    padding: 24,
    maxWidth: 900,
    alignSelf: "center",
    width: "100%",
  },
  previewContainerLandscape: {
    flex: 1.4,
    maxWidth: undefined,
    alignSelf: "auto",
    padding: 0,
  },
  previewSurface: {
    width: "100%",
    aspectRatio: 1.33,
    backgroundColor: "#0e0e11",
    borderRadius: 32,
    alignSelf: "center",
    overflow: "hidden",
    position: "relative",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.06)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.4,
    shadowRadius: 20,
  },
  previewSurfaceLandscape: {
    aspectRatio: 1.4,
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
    transform: [{ scale: 0.96 }],
  },
  previewError: {
    color: Theme.colors.error,
    fontSize: 14,
    marginTop: 16,
    textAlign: "center",
    fontWeight: "600",
    paddingHorizontal: 24,
  },
  previewHint: {
    color: Theme.colors.mutedForeground,
    fontSize: 14,
    marginTop: 16,
    textAlign: "center",
    lineHeight: 22,
    paddingHorizontal: 24,
  },
  sheetContainer: {
    backgroundColor: "#16161a",
    borderTopLeftRadius: 36,
    borderTopRightRadius: 36,
    paddingHorizontal: 48,
    paddingTop: 24,
    paddingBottom: Platform.OS === "ios" ? 48 : 32,
    gap: 24,
    borderTopWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    shadowColor: "#000",
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: 0.3,
    shadowRadius: 24,
    elevation: 20,
    maxWidth: 600,
    alignSelf: "center",
    width: "100%",
  },
  sheetContainerLandscape: {
    flex: 1,
    maxWidth: 420,
    borderRadius: 32,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    borderWidth: 1,
    paddingHorizontal: 32,
    paddingTop: 32,
    paddingBottom: 32,
    alignSelf: "auto",
  },
  sheetHandle: {
    width: 48,
    height: 5,
    borderRadius: 3,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignSelf: "center",
    marginBottom: 12,
  },
  sheetHeader: {
    alignItems: "center",
    marginBottom: 8,
  },
  roomName: {
    color: Theme.colors.foreground,
    fontSize: 28,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.8,
  },
  inputCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 20,
    paddingHorizontal: 20,
    height: 64,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  inputCardFocused: {
    borderColor: Theme.colors.primary,
    backgroundColor: "rgba(27, 182, 166, 0.04)",
  },
  inputIcon: {
    marginRight: 16,
  },
  nameInput: {
    flex: 1,
    color: "white",
    fontSize: 18,
    fontWeight: "600",
    padding: 0,
  },
  mediaRow: {
    flexDirection: "row",
    justifyContent: "center",
    gap: 24,
  },
  controlCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
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
    height: 64,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
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
    fontSize: 18,
    fontWeight: "800",
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
