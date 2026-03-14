import { HugeiconsIcon } from "@hugeicons/react-native";
import { 
  Mic01Icon, 
  MicOff01Icon, 
  VideoIcon, 
  VideoOffIcon, 
  Settings01Icon, 
  Grid02Icon, 
  Sun01Icon, 
  Moon01Icon, 
  ArrowDown01Icon 
} from "@hugeicons/core-free-icons";
import { useMemo, useState } from "react";
import { InteractionManager, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { Theme } from "../ui/theme";

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
  onJoin: (settings: NativeJoinSettings) => void;
  onCancel?: () => void;
}

export function NativePreJoinLobby({
  roomName,
  role = "participant",
  userName = role === "host" ? "Host" : "Guest",
  initialAudioEnabled = true,
  initialVideoEnabled = true,
  error,
  onJoin,
  onCancel,
}: NativePreJoinLobbyProps): React.JSX.Element {
  const [displayName, setDisplayName] = useState(userName);
  const [audioEnabled, setAudioEnabled] = useState(initialAudioEnabled);
  const [videoEnabled, setVideoEnabled] = useState(initialVideoEnabled);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const previewLabel = useMemo(() => (displayName.trim().charAt(0) || "H").toUpperCase(), [displayName]);

  const safelyChangeScreen = (action: () => void) => {
    Keyboard.dismiss();
    requestAnimationFrame(() => {
      InteractionManager.runAfterInteractions(action);
    });
  };

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.screen}>
      <ScrollView bounces={false} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <View style={styles.header}>
          <Pressable onPress={onCancel ? () => safelyChangeScreen(onCancel) : undefined} style={styles.brandRow}>
            {/* Provide a colorful placeholder block for Chalk logo since we can't depend on app assets easily */}
            <View style={styles.logoBlock}>
              <View style={styles.logoStripeBlue} />
              <View style={styles.logoStripeYellow} />
              <View style={styles.logoStripeRed} />
            </View>
            <Text style={styles.brandText}>chalk</Text>
          </Pressable>

          <View style={styles.headerDivider} />

          <Text style={styles.headerTitle} numberOfLines={1}>
            {roomName || "Meeting On Chalk"}
          </Text>

          <Pressable onPress={() => setIsDarkMode((current) => !current)} style={styles.themeButton}>
            <HugeiconsIcon color="white" icon={isDarkMode ? Sun01Icon : Moon01Icon} size={22} strokeWidth={1.8} />
          </Pressable>
        </View>

        <View style={styles.previewContainer}>
          <View style={styles.previewGlow} />
          <View style={styles.previewSurface}>
            <View style={styles.previewBadge}>
              <View style={styles.previewBadgeDot} />
              <Text style={styles.previewBadgeText}>{role === "host" ? "Host" : "Guest"}</Text>
            </View>

            <View style={styles.previewAvatar}>
              <View style={styles.previewEyesRow}>
                <View style={styles.previewEyeDot} />
                <View style={styles.previewEyeDot} />
              </View>
              <Text style={styles.previewAvatarText}>{previewLabel}</Text>
            </View>

            <View style={styles.previewControls}>
              <View style={styles.mediaGroup}>
                <Pressable onPress={() => setAudioEnabled(!audioEnabled)} style={styles.mediaToggle}>
                  <HugeiconsIcon color={audioEnabled ? "white" : "#ef4444"} icon={audioEnabled ? Mic01Icon : MicOff01Icon} size={20} strokeWidth={1.8} />
                  <HugeiconsIcon color="rgba(255,255,255,0.4)" icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
                </Pressable>
                <View style={styles.controlDivider} />
                <Pressable onPress={() => setVideoEnabled(!videoEnabled)} style={styles.mediaToggle}>
                  <HugeiconsIcon color={videoEnabled ? "white" : "#ef4444"} icon={videoEnabled ? VideoIcon : VideoOffIcon} size={20} strokeWidth={1.8} />
                  <HugeiconsIcon color="rgba(255,255,255,0.4)" icon={ArrowDown01Icon} size={14} strokeWidth={1.8} />
                </Pressable>
              </View>

              <View style={styles.controlDividerVertical} />

              <Pressable style={styles.iconButton}>
                <HugeiconsIcon color="white" icon={Settings01Icon} size={20} strokeWidth={1.8} />
              </Pressable>

              <Pressable style={[styles.iconButton, styles.iconButtonActive]}>
                <HugeiconsIcon color="#22c55e" icon={Grid02Icon} size={20} strokeWidth={1.8} />
              </Pressable>
            </View>
          </View>
        </View>

        <View style={styles.joinPanel}>
          <Text style={styles.sectionTitle}>Ready to join?</Text>
          <Text style={styles.subtitle}>You'll be in a waiting room before entering the call</Text>

          <TextInput
            onChangeText={setDisplayName}
            placeholder="Enter your name"
            placeholderTextColor={Theme.colors.placeholder}
            style={styles.input}
            value={displayName}
          />

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <Pressable
            onPress={() =>
              safelyChangeScreen(() =>
                onJoin({
                  displayName,
                  audioEnabled,
                  videoEnabled,
                }),
              )
            }
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>Ask to join</Text>
          </Pressable>
        </View>

        <View style={styles.footer}>
          <Text style={styles.footerText}>sdk v0.0.75 · mobile ready</Text>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Theme.colors.background,
  },
  content: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 60,
    paddingBottom: 24,
    gap: 32,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    minHeight: 48,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  logoBlock: {
    flexDirection: "row",
    height: 24,
    width: 24,
    gap: 2,
    transform: [{ rotate: "15deg" }],
  },
  logoStripeBlue: { flex: 1, backgroundColor: "#7bc3e5", borderRadius: 2 },
  logoStripeYellow: { flex: 1, backgroundColor: "#fad06b", borderRadius: 2, marginTop: 4 },
  logoStripeRed: { flex: 1, backgroundColor: "#f58a8a", borderRadius: 2, marginTop: 2 },
  brandText: {
    color: Theme.colors.foreground,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.5,
    textTransform: "lowercase",
  },
  headerDivider: {
    width: 1,
    height: 20,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  headerTitle: {
    flex: 1,
    color: "rgba(255,255,255,0.85)",
    fontSize: 16,
    fontWeight: "600",
  },
  themeButton: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "flex-end",
    justifyContent: "center",
  },
  previewContainer: {
    position: "relative",
    paddingVertical: 10,
  },
  previewGlow: {
    position: "absolute",
    top: 0,
    left: 10,
    right: 10,
    bottom: 0,
    backgroundColor: "#22c55e",
    borderRadius: 32,
    opacity: 0.15,
    transform: [{ scale: 1.05 }],
  },
  previewSurface: {
    height: 240,
    borderRadius: 32,
    backgroundColor: "#26c25b",
    padding: 20,
    justifyContent: "space-between",
    overflow: "hidden",
  },
  previewBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.6)",
  },
  previewBadgeDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#22c55e",
  },
  previewBadgeText: {
    color: "#ffffff",
    fontSize: 16,
    fontWeight: "600",
  },
  previewAvatar: {
    alignSelf: "center",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: "rgba(255,255,255,0.12)",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    marginTop: -10,
  },
  previewEyesRow: {
    flexDirection: "row",
    gap: 36,
    marginBottom: 2,
  },
  previewEyeDot: {
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: "#ffffff",
  },
  previewAvatarText: {
    color: "#ffffff",
    fontSize: 40,
    fontWeight: "400",
  },
  previewControls: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(0,0,0,0.7)",
    borderRadius: 24,
    padding: 6,
    gap: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  mediaGroup: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  mediaToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 8,
    height: 36,
  },
  controlDivider: {
    width: 1,
    height: 16,
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  controlDividerVertical: {
    width: 1,
    height: 24,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  iconButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  iconButtonActive: {
    backgroundColor: "rgba(255,255,255,0.1)",
  },
  joinPanel: {
    gap: 16,
    marginTop: 8,
  },
  sectionTitle: {
    color: Theme.colors.foreground,
    fontSize: 36,
    fontWeight: "700",
    letterSpacing: -1,
  },
  subtitle: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 18,
    lineHeight: 26,
    marginBottom: 10,
  },
  input: {
    height: 60,
    borderRadius: 16,
    backgroundColor: "#0d1117",
    color: Theme.colors.foreground,
    paddingHorizontal: 20,
    fontSize: 18,
    fontWeight: "600",
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.1)",
  },
  error: {
    ...Theme.typography.meta,
    color: Theme.colors.error,
  },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#22c55e",
    borderRadius: 30,
    height: 60,
    marginTop: 4,
    shadowColor: "#22c55e",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 12,
    elevation: 4,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "800",
  },
  footer: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingTop: 40,
    paddingBottom: 20,
  },
  footerText: {
    color: "rgba(255,255,255,0.25)",
    fontSize: 12,
    fontWeight: "600",
    letterSpacing: 0.5,
  },
});
