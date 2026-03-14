import { Ionicons, MaterialCommunityIcons } from "@expo/vector-icons";
import { useMemo, useState } from "react";
import { Image, InteractionManager, Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { buildRoomRoute, getLobbySupport, type LobbyRoute, type RoomRoute } from "../lib/chalk";
import { Theme } from "../lib/theme";

export interface LobbyScreenProps {
  route: LobbyRoute;
  onBack: () => void;
  onJoin: (route: RoomRoute) => void;
}

export function LobbyScreen({ route, onBack, onJoin }: LobbyScreenProps): React.JSX.Element {
  const support = useMemo(() => getLobbySupport(route), [route]);
  const [displayName, setDisplayName] = useState(route.role === "host" ? "Host" : "Guest");
  const [audioEnabled, setAudioEnabled] = useState(true);
  const [videoEnabled, setVideoEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDarkMode, setIsDarkMode] = useState(true);
  const previewInitial = (displayName.trim().charAt(0) || "H").toUpperCase();

  const safelyChangeScreen = (action: () => void) => {
    Keyboard.dismiss();
    requestAnimationFrame(() => {
      InteractionManager.runAfterInteractions(action);
    });
  };

  const handleJoin = () => {
    if (!support.canJoin) {
      setError(support.reason ?? "This meeting path is not available in this build.");
      return;
    }

    setError(null);
    safelyChangeScreen(() => {
      onJoin(
        buildRoomRoute(route, {
          displayName,
          audioEnabled,
          videoEnabled,
        }),
      );
    });
  };

  return (
    <ScrollView bounces={false} contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={() => safelyChangeScreen(onBack)} style={styles.brandRow}>
          <Image source={require("../../assets/icon.png")} style={styles.logo} />
          <Text style={styles.brandText}>chalk</Text>
        </Pressable>

        <View style={styles.headerDivider} />

        <Text style={styles.headerTitle} numberOfLines={1}>{route.roomName || "Meeting On Chalk"}</Text>

        <Pressable onPress={() => setIsDarkMode((current) => !current)} style={styles.themeButton}>
          <Ionicons name={isDarkMode ? "sunny-outline" : "moon-outline"} size={22} color="white" />
        </Pressable>
      </View>

      <View style={styles.previewContainer}>
        <View style={styles.previewGlow} />
        <View style={styles.previewSurface}>
          <View style={styles.previewBadge}>
            <View style={styles.previewBadgeDot} />
            <Text style={styles.previewBadgeText}>{route.role === "host" ? "Host" : "Guest"}</Text>
          </View>

          <View style={styles.previewAvatar}>
            <View style={styles.previewEyesRow}>
              <View style={styles.previewEyeDot} />
              <View style={styles.previewEyeDot} />
            </View>
            <Text style={styles.previewInitial}>{previewInitial}</Text>
          </View>

          <View style={styles.previewControls}>
            <View style={styles.mediaGroup}>
              <Pressable onPress={() => setAudioEnabled(!audioEnabled)} style={styles.mediaToggle}>
                <Ionicons name={audioEnabled ? "mic" : "mic-off"} size={20} color={audioEnabled ? "white" : "#ef4444"} />
                <Ionicons name="chevron-down" size={14} color="rgba(255,255,255,0.4)" />
              </Pressable>
              <View style={styles.controlDivider} />
              <Pressable onPress={() => setVideoEnabled(!videoEnabled)} style={styles.mediaToggle}>
                <Ionicons name={videoEnabled ? "videocam" : "videocam-off"} size={20} color={videoEnabled ? "white" : "#ef4444"} />
                <Ionicons name="chevron-down" size={14} color="rgba(255,255,255,0.4)" />
              </Pressable>
            </View>
            
            <View style={styles.controlDividerVertical} />
            
            <Pressable style={styles.iconButton}>
              <Ionicons name="settings-outline" size={20} color="white" />
            </Pressable>
            
            <Pressable style={[styles.iconButton, styles.iconButtonActive]}>
              <MaterialCommunityIcons name="grid-large" size={20} color="#22c55e" />
            </Pressable>
          </View>
        </View>
      </View>

      <View style={styles.joinPanel}>
        <Text style={styles.sectionTitle}>Ready to join?</Text>
        <Text style={styles.subtitle}>You&apos;ll be in a waiting room before entering the call</Text>
        
        <TextInput
          onChangeText={setDisplayName}
          placeholder="Enter your name"
          placeholderTextColor={Theme.colors.placeholder}
          style={styles.input}
          value={displayName}
        />

        {support.canJoin === false && support.reason ? <Text style={styles.warning}>{support.reason}</Text> : null}
        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable onPress={handleJoin} style={[styles.primaryButton, !support.canJoin && styles.buttonDisabled]}>
          <Text style={styles.primaryButtonText}>Ask to join</Text>
        </Pressable>
      </View>

      <View style={styles.footer}>
        <Text style={styles.footerText}>sdk v0.0.74 · web v0.1.0</Text>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    backgroundColor: Theme.colors.background,
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
  logo: {
    width: 32,
    height: 32,
  },
  brandText: {
    color: Theme.colors.foreground,
    fontSize: 18,
    fontWeight: "700",
    letterSpacing: -0.5,
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
  previewInitial: {
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
  warning: {
    ...Theme.typography.meta,
    color: Theme.colors.warning,
  },
  error: {
    ...Theme.typography.label,
    color: Theme.colors.error,
  },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "#22c55e",
    borderRadius: 30,
    height: 60,
    marginTop: 4,
    ...Theme.shadows.md,
  },
  primaryButtonText: {
    color: "#ffffff",
    fontSize: 18,
    fontWeight: "800",
  },
  buttonDisabled: {
    opacity: 0.45,
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
