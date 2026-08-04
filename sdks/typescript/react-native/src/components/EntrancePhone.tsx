import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import MicOff01Icon from "@hugeicons/core-free-icons/dist/esm/MicOff01Icon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import VideoOffIcon from "@hugeicons/core-free-icons/dist/esm/VideoOffIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useEffect, useRef } from "react";
import { AccessibilityInfo, Animated, Easing, KeyboardAvoidingView, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";

import { RTCView } from "../media/native-webrtc";
import { Theme } from "../ui/theme";
import { ChalkLogoElements } from "./ChalkLogoElements";
import { FaceAvatar } from "./FaceAvatar";
import type { PreJoinScreenProps } from "./PreJoinScreen";
import { usePreJoinScreenController } from "./native-prejoin/usePreJoinScreenController";

export function EntrancePhone({ roomName, error, joinDisabled = false, logo, onCancel, ...props }: PreJoinScreenProps): React.JSX.Element {
  const controller = usePreJoinScreenController({ ...props, joinDisabled });
  const { height, width } = useWindowDimensions();
  const entranceProgress = useRef(new Animated.Value(0)).current;
  const previewHeight = Math.min(width - Theme.spacing["2xl"] * 2, 520, height * 0.38);

  useEffect(() => {
    let mounted = true;
    let animation: Animated.CompositeAnimation | undefined;
    void AccessibilityInfo.isReduceMotionEnabled().then((reduceMotion) => {
      if (!mounted || reduceMotion) {
        entranceProgress.setValue(1);
        return;
      }
      animation = Animated.timing(entranceProgress, {
        toValue: 1,
        duration: 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      });
      animation.start();
    });
    return () => {
      mounted = false;
      animation?.stop();
    };
  }, [entranceProgress]);

  const animatedStyle = {
    opacity: entranceProgress,
    transform: [
      {
        translateY: entranceProgress.interpolate({
          inputRange: [0, 1],
          outputRange: [12, 0],
        }),
      },
    ],
  };

  return (
    <SafeAreaView style={styles.screen}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.screen}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.header}>
            <View style={styles.headerSide}>
              {onCancel ? (
                <Pressable accessibilityLabel="Back" accessibilityRole="button" hitSlop={8} onPress={onCancel} style={({ pressed }) => [styles.backButton, pressed && styles.pressed]}>
                  <HugeiconsIcon color={Theme.colors.foreground} icon={ArrowLeft01Icon} size={22} />
                </Pressable>
              ) : null}
            </View>
            <View style={styles.headerTitle}>
              <Text numberOfLines={1} style={styles.spaceName}>
                {roomName}
              </Text>
              <Text style={styles.entranceLabel}>Entrance</Text>
            </View>
            <View style={[styles.headerSide, styles.logo]}>{logo ?? <ChalkLogoElements size={30} />}</View>
          </View>

          <Animated.View style={[styles.content, animatedStyle]}>
            <View style={[styles.previewSurface, { height: previewHeight }]}>
              {controller.previewStream && controller.videoEnabled ? (
                <RTCView mirror objectFit="cover" streamURL={controller.previewStream.toURL()} style={styles.previewVideo} zOrder={0} />
              ) : (
                <View style={styles.avatarSurface}>
                  <FaceAvatar name={controller.displayName} size={104} textSize={38} />
                </View>
              )}
              <View style={styles.nameTag}>
                <Text numberOfLines={1} style={styles.nameTagText}>
                  {controller.displayName || "Guest"}
                </Text>
              </View>
            </View>

            {controller.previewError && controller.videoEnabled ? <Text style={styles.errorText}>{controller.previewError}</Text> : null}

            <View style={styles.mediaRow}>
              <MediaControl enabled={controller.audioEnabled} label="Microphone" onPress={controller.toggleAudio} type="microphone" disabled={controller.simulatorMediaDisabled} />
              <MediaControl enabled={controller.videoEnabled} label="Camera" onPress={controller.toggleVideo} type="camera" disabled={controller.simulatorMediaDisabled} />
            </View>

            <View style={styles.fieldGroup}>
              <Text style={styles.fieldLabel}>Display name</Text>
              <TextInput
                accessibilityLabel="Display name"
                autoCapitalize="words"
                maxLength={30}
                onBlur={() => controller.setInputFocused(false)}
                onChangeText={controller.setDisplayName}
                onFocus={() => controller.setInputFocused(true)}
                onSubmitEditing={controller.handleJoin}
                placeholder="Your name"
                placeholderTextColor={Theme.colors.placeholder}
                returnKeyType="join"
                style={[styles.nameInput, controller.isInputFocused && styles.nameInputFocused]}
                value={controller.displayName}
              />
            </View>

            {error ? <Text style={styles.errorText}>{error}</Text> : null}

            <Pressable accessibilityRole="button" disabled={joinDisabled || controller.isSubmitting} onPress={controller.handleJoin} style={({ pressed }) => [styles.joinButton, (joinDisabled || controller.isSubmitting) && styles.disabled, pressed && styles.joinButtonPressed]}>
              <Text style={styles.joinButtonText}>{controller.isSubmitting || joinDisabled ? "Joining Space…" : "Join Space"}</Text>
            </Pressable>
          </Animated.View>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function MediaControl({ disabled, enabled, label, onPress, type }: { readonly disabled: boolean; readonly enabled: boolean; readonly label: string; readonly onPress: () => void; readonly type: "microphone" | "camera" }): React.JSX.Element {
  const icon = type === "microphone" ? (enabled ? Mic01Icon : MicOff01Icon) : enabled ? Video01Icon : VideoOffIcon;
  return (
    <Pressable accessibilityLabel={`${label} ${enabled ? "on" : "off"}`} accessibilityRole="button" disabled={disabled} onPress={onPress} style={({ pressed }) => [styles.mediaControl, disabled && styles.disabled, pressed && styles.pressed]}>
      <View style={[styles.mediaButton, !enabled && styles.mediaButtonOff]}>
        <HugeiconsIcon color="#FFFFFF" icon={icon} size={24} />
      </View>
      <Text style={styles.mediaLabel}>{label}</Text>
      <Text style={styles.mediaState}>{enabled ? "On" : "Off"}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Theme.colors.background },
  scrollContent: {
    flexGrow: 1,
    paddingTop: Platform.OS === "android" ? Theme.spacing.lg : Theme.spacing.sm,
    paddingBottom: Platform.OS === "ios" ? Theme.spacing["3xl"] : Theme.spacing.xl,
  },
  header: {
    minHeight: 64,
    paddingHorizontal: Theme.spacing.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerSide: { width: 52, alignItems: "flex-start" },
  logo: { alignItems: "flex-end" },
  backButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: Theme.radius.sm,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.card,
  },
  headerTitle: { flex: 1, alignItems: "center", paddingHorizontal: Theme.spacing.sm },
  spaceName: { ...Theme.typography.subheading, color: Theme.colors.foreground, textAlign: "center" },
  entranceLabel: { ...Theme.typography.meta, color: Theme.colors.mutedForeground, marginTop: 1 },
  content: { alignSelf: "center", flex: 1, gap: Theme.spacing.lg, maxWidth: 720, paddingHorizontal: Theme.spacing.lg, paddingTop: Theme.spacing.sm, width: "100%" },
  previewSurface: {
    width: "100%",
    overflow: "hidden",
    borderRadius: Theme.radius.md,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.washBlue,
  },
  previewVideo: { ...StyleSheet.absoluteFillObject },
  avatarSurface: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: Theme.colors.washBlue },
  nameTag: {
    position: "absolute",
    left: Theme.spacing.md,
    bottom: Theme.spacing.md,
    maxWidth: "72%",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 5,
    backgroundColor: "rgba(12,14,18,0.80)",
  },
  nameTagText: { color: "#FFFFFF", fontSize: 13, fontWeight: "600" },
  mediaRow: { flexDirection: "row", justifyContent: "center", gap: Theme.spacing["2xl"] },
  mediaControl: { minWidth: 104, minHeight: 82, alignItems: "center", justifyContent: "center" },
  mediaButton: { width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", backgroundColor: Theme.colors.ink },
  mediaButtonOff: { backgroundColor: Theme.colors.error },
  mediaLabel: { ...Theme.typography.label, color: Theme.colors.foreground, marginTop: 8 },
  mediaState: { ...Theme.typography.meta, color: Theme.colors.mutedForeground },
  fieldGroup: { gap: Theme.spacing.sm },
  fieldLabel: { ...Theme.typography.label, color: Theme.colors.foreground },
  nameInput: {
    minHeight: 52,
    borderRadius: Theme.radius.md,
    borderWidth: 1,
    borderColor: Theme.colors.input,
    backgroundColor: Theme.colors.card,
    color: Theme.colors.foreground,
    fontSize: 16,
    paddingHorizontal: Theme.spacing.lg,
  },
  nameInputFocused: { borderColor: Theme.colors.chalkBlue, borderWidth: 2, paddingHorizontal: Theme.spacing.lg - 1 },
  joinButton: { minHeight: 54, borderRadius: Theme.radius.sm, backgroundColor: Theme.colors.ink, alignItems: "center", justifyContent: "center" },
  joinButtonPressed: { opacity: 0.82, transform: [{ scale: 0.985 }] },
  joinButtonText: { color: "#FFFFFF", fontSize: 16, fontWeight: "700" },
  errorText: { ...Theme.typography.meta, color: Theme.colors.error, textAlign: "center" },
  disabled: { opacity: 0.45 },
  pressed: { opacity: 0.72, transform: [{ scale: 0.97 }] },
});
