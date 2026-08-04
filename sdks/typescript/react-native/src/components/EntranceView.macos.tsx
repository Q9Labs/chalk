import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import UserIcon from "@hugeicons/core-free-icons/dist/esm/UserIcon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { Theme } from "../ui/theme";
import { useNativeTheme } from "../ui/native-theme";
import { getIosSimulatorMediaMessage } from "../utils/ios-simulator";
import { FaceAvatar } from "./FaceAvatar";
import { hasRtcVideoView, RtcVideoView } from "./RtcVideoView";
import type { EntranceViewProps } from "./EntranceView";
import { useEntranceController } from "./native-entrance/useEntranceController";

export function EntranceViewMacos({ spaceName, error, joinDisabled = false, onCancel, ...props }: EntranceViewProps): React.JSX.Element {
  const controller = useEntranceController({ ...props, joinDisabled });
  const theme = useNativeTheme();
  const canJoin = controller.displayName.trim().length > 0 && !joinDisabled && !controller.isSubmitting;
  const canRenderPreview = hasRtcVideoView();
  const showPreview = Boolean(controller.previewStream && controller.videoEnabled && canRenderPreview);
  const previewStreamURL = showPreview && controller.previewStream ? controller.previewStream.toURL() : null;
  const previewStatusMessage = controller.videoEnabled && controller.previewStream && !canRenderPreview ? "Camera preview is unavailable on this device." : controller.previewError;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      <View style={styles.content}>
        <View style={styles.previewContainer}>
          <View style={[styles.previewSurface, { backgroundColor: theme.colors.raisedSurface, borderColor: theme.colors.border }]}>
            {previewStreamURL ? (
              <RtcVideoView mirror objectFit="cover" streamURL={previewStreamURL} style={styles.previewVideo} zOrder={0} />
            ) : (
              <View style={[styles.avatarContainer, { backgroundColor: theme.colors.insetSurface }]}>
                <FaceAvatar name={controller.displayName} size={140} textSize={52} />
              </View>
            )}

            {onCancel ? (
              <Pressable accessibilityLabel="Cancel and leave Entrance" accessibilityRole="button" onPress={onCancel} style={({ pressed }) => [styles.floatingBack, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }, pressed && styles.topIconButtonPressed]}>
                <HugeiconsIcon icon={ArrowLeft01Icon} size={22} color={theme.colors.foreground} />
              </Pressable>
            ) : null}
          </View>

          {previewStatusMessage ? <Text style={styles.previewError}>{previewStatusMessage}</Text> : null}
          {controller.simulatorMediaDisabled ? <Text style={styles.previewHint}>{getIosSimulatorMediaMessage()}</Text> : null}
        </View>

        <View style={[styles.sheetContainer, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, shadowColor: theme.colors.darkCanvas }]}>
          <View style={styles.sheetHandle} />
          <View style={styles.sheetHeader}>
            <Text style={[styles.spaceName, { color: theme.colors.foreground }]} numberOfLines={1}>
              {spaceName}
            </Text>
          </View>

          <View style={[styles.inputCard, { backgroundColor: theme.colors.surface, borderColor: controller.isInputFocused ? theme.colors.ring : theme.colors.border }]}>
            <HugeiconsIcon icon={UserIcon} size={18} color={controller.isInputFocused ? theme.colors.primary : theme.colors.mutedForeground} style={styles.inputIcon} />
            <TextInput
              onChangeText={controller.setDisplayName}
              onFocus={() => controller.setInputFocused(true)}
              onBlur={() => controller.setInputFocused(false)}
              placeholder="Enter your name"
              placeholderTextColor={theme.colors.mutedForeground}
              style={[styles.nameInput, { color: theme.colors.foreground }]}
              value={controller.displayName}
              maxLength={30}
              returnKeyType="join"
              onSubmitEditing={controller.handleJoin}
            />
          </View>

          <View style={styles.mediaRow}>
            <Pressable
              disabled={controller.simulatorMediaDisabled}
              onPress={controller.toggleAudio}
              style={({ pressed }) => [styles.controlCircle, { backgroundColor: controller.audioEnabled ? theme.colors.controlsBackground : theme.colors.error, borderColor: theme.colors.border }, controller.simulatorMediaDisabled && styles.toggleCircleDisabled, pressed && styles.togglePressed]}
            >
              <HugeiconsIcon icon={controller.audioEnabled ? Mic01Icon : MicOff01Icon} size={24} color={theme.colors.primaryForeground} />
            </Pressable>
            <Pressable
              disabled={controller.simulatorMediaDisabled}
              onPress={controller.toggleVideo}
              style={({ pressed }) => [styles.controlCircle, { backgroundColor: controller.videoEnabled ? theme.colors.controlsBackground : theme.colors.error, borderColor: theme.colors.border }, controller.simulatorMediaDisabled && styles.toggleCircleDisabled, pressed && styles.togglePressed]}
            >
              <HugeiconsIcon icon={controller.videoEnabled ? Video01Icon : VideoOffIcon} size={24} color={theme.colors.primaryForeground} />
            </Pressable>
          </View>

          {error ? <Text style={[styles.globalError, { color: theme.colors.error }]}>{error}</Text> : null}

          <Pressable disabled={!canJoin} onPress={controller.handleJoin} style={({ pressed }) => [styles.joinButton, { backgroundColor: canJoin ? theme.colors.primary : theme.colors.muted }, !canJoin && styles.joinButtonDisabled, pressed && styles.togglePressed]}>
            <Text style={[styles.joinButtonText, { color: theme.colors.primaryForeground }]}>{controller.isSubmitting || joinDisabled ? "Joining..." : "Enter Space"}</Text>
          </Pressable>
        </View>
      </View>
    </KeyboardAvoidingView>
  );
}

export { EntranceViewMacos as EntranceView };

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
    backgroundColor: Theme.colors.darkOverlay40,
    alignItems: "center",
    justifyContent: "center",
    zIndex: 10,
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay10,
  },
  previewContainer: {
    flex: 1,
    justifyContent: "center",
    paddingTop: Platform.OS === "ios" ? 10 : 0,
    marginBottom: 0,
  },
  previewSurface: {
    width: "100%",
    aspectRatio: 0.72,
    backgroundColor: Theme.colors.raisedSurface,
    borderRadius: 32,
    alignSelf: "center",
    overflow: "hidden",
    position: "relative",
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay06,
  },
  previewVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  avatarContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.insetSurface,
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
  sheetContainer: {
    backgroundColor: Theme.colors.elevatedSurface,
    borderTopLeftRadius: 32,
    borderTopRightRadius: 32,
    paddingHorizontal: 24,
    paddingTop: 16,
    paddingBottom: Platform.OS === "ios" ? 44 : 32,
    gap: 20,
    borderTopWidth: 1,
    borderColor: Theme.colors.whiteOverlay08,
    shadowColor: Theme.colors.darkCanvas,
    shadowOffset: { width: 0, height: -12 },
    shadowOpacity: 0.3,
    shadowRadius: 16,
    elevation: 20,
  },
  sheetHandle: {
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: Theme.colors.whiteOverlay10,
    alignSelf: "center",
    marginBottom: 8,
  },
  sheetHeader: {
    alignItems: "center",
    marginBottom: 4,
  },
  spaceName: {
    color: Theme.colors.foreground,
    fontSize: 22,
    fontWeight: "800",
    textAlign: "center",
    letterSpacing: -0.6,
  },
  inputCard: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Theme.colors.whiteOverlay04,
    borderRadius: 18,
    paddingHorizontal: 16,
    height: 56,
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay08,
  },
  inputCardFocused: {
    borderColor: Theme.colors.primary,
    backgroundColor: Theme.colors.accentOverlay04,
  },
  inputIcon: {
    marginRight: 24,
  },
  nameInput: {
    flex: 1,
    color: Theme.colors.onDark,
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
    backgroundColor: Theme.colors.whiteOverlay06,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay10,
  },
  toggleCircleOff: {
    backgroundColor: Theme.colors.dangerStrong,
    borderColor: Theme.colors.dangerStrong,
  },
  toggleCircleDisabled: {
    opacity: 0.45,
  },
  joinButton: {
    width: "100%",
    height: 58,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  joinButtonDisabled: {
    opacity: 0.6,
  },
  joinButtonText: {
    color: Theme.colors.onDark,
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
