import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import ArrowRight02Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight02Icon";
import CancelCircleIcon from "@hugeicons/core-free-icons/dist/esm/CancelCircleIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { getParticipantAvatarRecipe } from "@q9labs/chalk-core";
import { KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View, Animated, ActivityIndicator } from "react-native";
import { Theme } from "../ui/theme";
import { getIosSimulatorMediaMessage } from "../utils/ios-simulator";
import { NativeFaceAvatar } from "./NativeFaceAvatar";
import { hasNativeRtcVideoView, NativeRtcVideoView } from "./NativeRtcVideoView";
import type { NativePreJoinLobbyProps } from "./NativePreJoinLobby";
import { useNativePreJoinLobbyController } from "./native-prejoin/useNativePreJoinLobbyController";
import { useEffect, useMemo, useRef } from "react";

export function NativePreJoinLobbyIosPad({ roomName, error, joinDisabled = false, onCancel, ...props }: NativePreJoinLobbyProps): React.JSX.Element {
  const controller = useNativePreJoinLobbyController({ ...props, joinDisabled });
  const canRenderPreview = hasNativeRtcVideoView();
  const entryAnim = useRef(new Animated.Value(0)).current;
  const islandAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
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
    ]).start();
  }, [entryAnim, islandAnim]);

  const canJoin = controller.displayName.trim().length > 0 && !joinDisabled && !controller.isSubmitting;
  const avatarColors = useMemo(() => getParticipantAvatarRecipe(controller.displayName || "guest").colors, [controller.displayName]);
  const showPreview = Boolean(controller.previewStream && controller.videoEnabled && canRenderPreview);
  const previewStreamURL = showPreview && controller.previewStream ? controller.previewStream.toURL() : null;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.screen}>
      {/* Immersive Background */}
      <View style={styles.immersiveContainer}>
        {previewStreamURL ? (
          <NativeRtcVideoView mirror objectFit="cover" streamURL={previewStreamURL} style={styles.fullScreenVideo} zOrder={-1} />
        ) : (
          <View style={styles.immersiveAvatarContainer}>
            <NativeFaceAvatar name={controller.displayName} size={200} textSize={80} />
          </View>
        )}
        {/* Subtle Brand Frost - only show over video, not avatar */}
        {showPreview ? <View style={styles.frostOverlay} /> : null}
      </View>

      <View style={styles.hudLayer}>
        {/* Top HUD */}
        <View style={styles.topHud}>
          <Pressable onPress={onCancel} style={({ pressed }) => [styles.backPuck, pressed && styles.pressed]}>
            <HugeiconsIcon icon={ArrowLeft01Icon} size={22} color="white" />
          </Pressable>
          <View style={styles.roomInfo}>
            <Text style={styles.roomTitle} numberOfLines={1}>
              {roomName}
            </Text>
          </View>
          <View style={styles.topHudSpacer} />
        </View>

        <View style={styles.flexFill} />

        {/* Bottom HUD */}
        <Animated.View
          style={[
            styles.bottomHud,
            {
              opacity: islandAnim,
              transform: [{ translateY: islandAnim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }],
            },
          ]}
        >
          {/* Unified Launch Pad */}
          <View style={styles.launchPad}>
            {/* Media Controls Integrated */}
            <View style={styles.mediaGroup}>
              <Pressable disabled={controller.simulatorMediaDisabled} onPress={controller.toggleAudio} style={({ pressed }) => [styles.mediaToggle, !controller.audioEnabled && styles.toggleOff, pressed && styles.pressed]}>
                <HugeiconsIcon icon={controller.audioEnabled ? Mic01Icon : MicOff01Icon} size={22} color="white" />
              </Pressable>
              <Pressable disabled={controller.simulatorMediaDisabled} onPress={controller.toggleVideo} style={({ pressed }) => [styles.mediaToggle, !controller.videoEnabled && styles.toggleOff, pressed && styles.pressed]}>
                <HugeiconsIcon icon={controller.videoEnabled ? Video01Icon : VideoOffIcon} size={22} color="white" />
              </Pressable>
            </View>

            <View style={styles.islandDivider} />

            {/* Identity Field */}
            <View style={[styles.identityArea, controller.isInputFocused && styles.identityAreaFocused]}>
              <TextInput
                onChangeText={controller.setDisplayName}
                onFocus={() => controller.setInputFocused(true)}
                onBlur={() => controller.setInputFocused(false)}
                placeholder="Enter your name to join"
                placeholderTextColor="rgba(255,255,255,0.4)"
                style={styles.immersiveInput}
                value={controller.displayName}
                maxLength={30}
                returnKeyType="join"
                onSubmitEditing={controller.handleJoin}
              />
              {controller.displayName.length > 0 && (
                <Pressable onPress={() => controller.setDisplayName("")} style={styles.clearAction}>
                  <HugeiconsIcon icon={CancelCircleIcon} size={18} color="rgba(255,255,255,0.4)" />
                </Pressable>
              )}
            </View>

            <Pressable
              disabled={!canJoin}
              onPress={controller.handleJoin}
              style={({ pressed }) => [
                styles.joinArrow,
                canJoin && {
                  backgroundColor: avatarColors.primary,
                  shadowColor: avatarColors.primary,
                  shadowOffset: { width: 0, height: 4 },
                  shadowOpacity: 0.3,
                  shadowRadius: 8,
                },
                pressed && canJoin && styles.pressed,
                controller.isSubmitting && styles.disabled,
              ]}
            >
              {controller.isSubmitting ? <ActivityIndicator color="white" size="small" /> : <HugeiconsIcon icon={ArrowRight02Icon} size={28} color={canJoin ? "white" : "rgba(255,255,255,0.2)"} />}
            </Pressable>
          </View>

          {error ? <Text style={styles.immersiveError}>{error}</Text> : null}
          {controller.simulatorMediaDisabled && <Text style={styles.simulatorHintText}>{getIosSimulatorMediaMessage()}</Text>}
        </Animated.View>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "black",
  },
  immersiveContainer: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "#050505",
  },
  fullScreenVideo: {
    ...StyleSheet.absoluteFillObject,
  },
  immersiveAvatarContainer: {
    ...StyleSheet.absoluteFillObject,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#0a0a0b",
  },
  frostOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
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
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  roomInfo: {
    alignItems: "center",
  },
  roomTitle: {
    color: "white",
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
    backgroundColor: "rgba(10,10,10,0.85)",
    borderRadius: 40,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    padding: 8,
    height: 80,
    shadowColor: "#000",
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
    backgroundColor: "rgba(255,255,255,0.06)",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.05)",
  },
  toggleOff: {
    backgroundColor: Theme.colors.error,
    borderColor: Theme.colors.error,
  },
  islandDivider: {
    width: 1,
    height: 32,
    backgroundColor: "rgba(255,255,255,0.1)",
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
    color: "white",
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
    backgroundColor: "rgba(255,255,255,0.05)",
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
    color: "rgba(255,255,255,0.5)",
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
