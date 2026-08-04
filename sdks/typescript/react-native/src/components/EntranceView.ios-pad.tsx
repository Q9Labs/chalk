import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import ArrowRight02Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight02Icon";
import CancelCircleIcon from "@hugeicons/core-free-icons/dist/esm/CancelCircleIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, Animated, ActivityIndicator } from "react-native";
import { Theme } from "../ui/theme";
import { useNativeTheme } from "../ui/native-theme";
import { getIosSimulatorMediaMessage } from "../utils/ios-simulator";
import { FaceAvatar } from "./FaceAvatar";
import { hasRtcVideoView, RtcVideoView } from "./RtcVideoView";
import type { EntranceViewProps } from "./EntranceView";
import { useEntranceController } from "./native-entrance/useEntranceController";
import { createAnimationRefController, type AnimationRefCallback } from "./native-animation-controller";
import { useRef } from "react";

export function EntranceViewIosPad({ spaceName, error, joinDisabled = false, onCancel, ...props }: EntranceViewProps): React.JSX.Element {
  const controller = useEntranceController({ ...props, joinDisabled });
  const theme = useNativeTheme();
  const canRenderPreview = hasRtcVideoView();
  const entryAnim = useRef(new Animated.Value(0)).current;
  const islandAnim = useRef(new Animated.Value(0)).current;
  const animationRef = useRef<AnimationRefCallback<unknown> | null>(null);
  const attachEntryAnimation =
    animationRef.current ??
    (animationRef.current = createAnimationRefController<unknown>(() => [
      Animated.stagger(300, [
        Animated.spring(entryAnim, {
          toValue: 1,
          tension: 20,
          friction: 8,
          useNativeDriver: true,
        }),
        Animated.spring(islandAnim, {
          toValue: 1,
          tension: 25,
          friction: 9,
          useNativeDriver: true,
        }),
      ]),
    ]));

  const canJoin = controller.displayName.trim().length > 0 && !joinDisabled && !controller.isSubmitting;
  const showPreview = Boolean(controller.previewStream && controller.videoEnabled && canRenderPreview);
  const previewStreamURL = showPreview && controller.previewStream ? controller.previewStream.toURL() : null;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={[styles.screen, { backgroundColor: theme.colors.background }]}>
      {/* Immersive Background */}
      <View style={[styles.immersiveContainer, { backgroundColor: theme.colors.darkCanvas }]}>
        {previewStreamURL ? (
          <RtcVideoView mirror objectFit="cover" streamURL={previewStreamURL} style={styles.fullScreenVideo} zOrder={-1} />
        ) : (
          <View style={[styles.immersiveAvatarContainer, { backgroundColor: theme.colors.background }]}>
            <FaceAvatar name={controller.displayName} size={200} textSize={80} />
          </View>
        )}
        {/* Subtle Brand Frost - only show over video, not avatar */}
        {showPreview ? <View style={styles.frostOverlay} /> : null}
      </View>

      <View style={styles.hudLayer}>
        {/* Top HUD */}
        <View style={styles.topHud}>
          {onCancel ? (
            <Pressable accessibilityLabel="Cancel and leave Entrance" accessibilityRole="button" onPress={onCancel} style={({ pressed }) => [styles.backPuck, { backgroundColor: theme.colors.surface, borderColor: theme.colors.border }, pressed && styles.pressed]}>
              <HugeiconsIcon icon={ArrowLeft01Icon} size={22} color={theme.colors.foreground} />
            </Pressable>
          ) : null}
          <View style={styles.spaceInfo}>
            <Text style={[styles.spaceTitle, { color: theme.colors.foreground }]} numberOfLines={1}>
              {spaceName}
            </Text>
          </View>
          <View style={styles.topHudSpacer} />
        </View>

        <View style={styles.flexFill} />

        {/* Bottom HUD */}
        <Animated.View
          ref={attachEntryAnimation}
          style={[
            styles.bottomHud,
            {
              opacity: islandAnim,
              transform: [{ translateY: islandAnim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }],
            },
          ]}
        >
          {/* Unified Launch Pad */}
          <View style={[styles.launchPad, { backgroundColor: theme.colors.card, borderColor: theme.colors.border, shadowColor: theme.colors.darkCanvas }]}>
            {/* Media Controls Integrated */}
            <View style={styles.mediaGroup}>
              <Pressable
                accessibilityLabel={controller.audioEnabled ? "Mute microphone" : "Unmute microphone"}
                accessibilityRole="button"
                accessibilityState={{ disabled: controller.simulatorMediaDisabled, selected: controller.audioEnabled }}
                disabled={controller.simulatorMediaDisabled}
                onPress={controller.toggleAudio}
                style={({ pressed }) => [styles.mediaToggle, { backgroundColor: controller.audioEnabled ? theme.colors.controlsBackground : theme.colors.error, borderColor: theme.colors.border }, pressed && styles.pressed]}
              >
                <HugeiconsIcon icon={controller.audioEnabled ? Mic01Icon : MicOff01Icon} size={22} color={theme.colors.primaryForeground} />
              </Pressable>
              <Pressable
                accessibilityLabel={controller.videoEnabled ? "Turn camera off" : "Turn camera on"}
                accessibilityRole="button"
                accessibilityState={{ disabled: controller.simulatorMediaDisabled, selected: controller.videoEnabled }}
                disabled={controller.simulatorMediaDisabled}
                onPress={controller.toggleVideo}
                style={({ pressed }) => [styles.mediaToggle, { backgroundColor: controller.videoEnabled ? theme.colors.controlsBackground : theme.colors.error, borderColor: theme.colors.border }, pressed && styles.pressed]}
              >
                <HugeiconsIcon icon={controller.videoEnabled ? Video01Icon : VideoOffIcon} size={22} color={theme.colors.primaryForeground} />
              </Pressable>
            </View>

            <View style={styles.islandDivider} />

            {/* Identity Field */}
            <View style={[styles.identityArea, { backgroundColor: theme.colors.surface, borderColor: controller.isInputFocused ? theme.colors.ring : theme.colors.border }, controller.isInputFocused && styles.identityAreaFocused]}>
              <TextInput
                accessibilityLabel="Your name"
                onChangeText={controller.setDisplayName}
                onFocus={() => controller.setInputFocused(true)}
                onBlur={() => controller.setInputFocused(false)}
                placeholder="Enter your name to join"
                placeholderTextColor={theme.colors.mutedForeground}
                style={[styles.immersiveInput, { color: theme.colors.foreground }]}
                value={controller.displayName}
                maxLength={30}
                returnKeyType="join"
                onSubmitEditing={controller.handleJoin}
              />
              {controller.displayName.length > 0 && (
                <Pressable accessibilityLabel="Clear name" accessibilityRole="button" onPress={() => controller.setDisplayName("")} style={styles.clearAction}>
                  <HugeiconsIcon icon={CancelCircleIcon} size={18} color={theme.colors.mutedForeground} />
                </Pressable>
              )}
            </View>

            <Pressable
              accessibilityLabel="Enter Space"
              accessibilityRole="button"
              accessibilityState={{ disabled: !canJoin }}
              disabled={!canJoin}
              onPress={controller.handleJoin}
              style={({ pressed }) => [
                styles.joinArrow,
                canJoin && {
                  backgroundColor: theme.colors.primary,
                  shadowColor: theme.colors.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.3,
                  shadowRadius: 8,
                },
                pressed && canJoin && styles.pressed,
                controller.isSubmitting && styles.disabled,
              ]}
            >
              {controller.isSubmitting ? <ActivityIndicator color={theme.colors.primaryForeground} size="small" /> : <HugeiconsIcon icon={ArrowRight02Icon} size={28} color={canJoin ? theme.colors.primaryForeground : theme.colors.mutedForeground} />}
            </Pressable>
          </View>

          {error ? <Text style={[styles.immersiveError, { color: theme.colors.error }]}>{error}</Text> : null}
          {controller.simulatorMediaDisabled && <Text style={[styles.simulatorHintText, { color: theme.colors.mutedForeground }]}>{getIosSimulatorMediaMessage()}</Text>}
        </Animated.View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Theme.colors.darkCanvas,
  },
  immersiveContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Theme.colors.darkCanvas,
  },
  fullScreenVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  immersiveAvatarContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.background,
  },
  frostOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: Theme.colors.darkOverlay30,
  },
  hudLayer: {
    flex: 1,
    paddingHorizontal: 60,
    paddingTop: 40,
    paddingBottom: 60,
  },
  flexFill: {
    flex: 1,
  },
  topHud: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  backPuck: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: Theme.colors.whiteOverlay08,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay10,
  },
  spaceInfo: {
    alignItems: "center",
  },
  spaceTitle: {
    color: Theme.colors.onDark,
    fontSize: 28,
    fontWeight: "900",
    letterSpacing: -0.5,
  },
  topHudSpacer: {
    width: 52,
  },
  bottomHud: {
    width: "100%",
    maxWidth: 700,
    alignSelf: "center",
    gap: 16,
  },
  launchPad: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Theme.colors.canvasOverlay85,
    borderRadius: 40,
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay12,
    padding: 8,
    height: 80,
    shadowColor: Theme.colors.darkCanvas,
    shadowOffset: { width: 0, height: 12 },
    shadowOpacity: 0.5,
    shadowRadius: 20,
    elevation: 20,
  },
  mediaGroup: {
    flexDirection: "row",
    gap: 8,
    paddingLeft: 4,
  },
  mediaToggle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Theme.colors.whiteOverlay06,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: Theme.colors.whiteOverlay05,
  },
  toggleOff: {
    backgroundColor: Theme.colors.error,
    borderColor: Theme.colors.error,
  },
  islandDivider: {
    width: 1,
    height: 32,
    backgroundColor: Theme.colors.whiteOverlay10,
    marginHorizontal: 16,
  },
  identityArea: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    height: "100%",
    paddingHorizontal: 8,
  },
  identityAreaFocused: {},
  immersiveInput: {
    flex: 1,
    color: Theme.colors.onDark,
    fontSize: 20,
    fontWeight: "700",
    padding: 0,
    letterSpacing: -0.5,
  },
  clearAction: {
    padding: 10,
  },
  joinArrow: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: Theme.colors.whiteOverlay05,
    alignItems: "center",
    justifyContent: "center",
  },
  immersiveError: {
    color: Theme.colors.error,
    fontSize: 14,
    fontWeight: "700",
    textAlign: "center",
    marginTop: 8,
  },
  simulatorHintText: {
    color: Theme.colors.whiteOverlay50,
    fontSize: 12,
    textAlign: "center",
    fontWeight: "600",
  },
  pressed: {
    opacity: 0.7,
    transform: [{ scale: 0.94 }],
  },
  disabled: {
    opacity: 0.5,
  },
});
