import { useMemo, useState } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
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

  const handleJoin = () => {
    if (!support.canJoin) {
      setError(support.reason ?? "This meeting path is not available in this build.");
      return;
    }

    setError(null);
    onJoin(
      buildRoomRoute(route, {
        displayName,
        audioEnabled,
        videoEnabled,
      }),
    );
  };

  return (
    <ScrollView bounces={false} contentContainerStyle={styles.screen}>
      <View style={styles.header}>
        <Pressable onPress={onBack} style={styles.brandRow}>
          <Image source={require("../../assets/icon.png")} style={styles.logo} />
          <Text style={styles.brandText}>chalk</Text>
        </Pressable>

        <View style={styles.headerDivider} />

        <Text style={styles.headerTitle}>{route.roomName || "Meeting On Chalk"}</Text>

        <Pressable onPress={() => setIsDarkMode((current) => !current)} style={styles.themeButton}>
          <Text style={styles.themeButtonText}>{isDarkMode ? "Sun" : "Moon"}</Text>
        </Pressable>
      </View>

      <View style={styles.previewShell}>
        <View style={styles.previewSurface}>
          <View style={styles.previewBadge}>
            <View style={styles.previewBadgeDot} />
            <Text style={styles.previewBadgeText}>{displayName.trim() || "Host"}</Text>
          </View>

          <View style={styles.previewAvatar}>
            <View style={styles.previewEyesRow}>
              <View style={styles.previewEyeDot} />
              <View style={styles.previewEyeDot} />
            </View>
            <Text style={styles.previewInitial}>{previewInitial}</Text>
          </View>

          <View style={styles.previewControls}>
            <ControlPill active={audioEnabled} label={audioEnabled ? "Mic" : "Mic off"} onPress={() => setAudioEnabled((current) => !current)} />
            <ControlPill active={videoEnabled} label={videoEnabled ? "Cam" : "Cam off"} onPress={() => setVideoEnabled((current) => !current)} />
            <ControlPill active={false} label="Set" onPress={() => {}} />
            <ControlPill active label="Grid" onPress={() => {}} />
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

        {!support.canJoin && support.reason ? <Text style={styles.warning}>{support.reason}</Text> : null}
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

function ControlPill({
  active,
  label,
  onPress,
}: {
  active: boolean;
  label: string;
  onPress: () => void;
}): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={[styles.controlPill, active ? styles.controlPillActive : null]}>
      <Text style={[styles.controlPillText, active ? styles.controlPillTextActive : styles.controlPillTextInactive]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    backgroundColor: Theme.colors.background,
    paddingHorizontal: 24,
    paddingTop: 18,
    paddingBottom: 24,
    gap: 18,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: 14,
    minHeight: 48,
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexShrink: 0,
  },
  logo: {
    width: 30,
    height: 30,
    borderRadius: 8,
  },
  brandText: {
    color: Theme.colors.foreground,
    fontSize: 16,
    fontWeight: "700",
    textTransform: "lowercase",
  },
  headerDivider: {
    width: 1,
    height: 24,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  headerTitle: {
    flex: 1,
    color: "#8f96a3",
    fontSize: 16,
    fontWeight: "700",
    textAlign: "center",
  },
  themeButton: {
    minWidth: 44,
    alignItems: "flex-end",
  },
  themeButtonText: {
    color: "#d4d8df",
    fontSize: 12,
    fontWeight: "700",
  },
  previewShell: {
    marginTop: 10,
    paddingHorizontal: 0,
    paddingVertical: 18,
    borderRadius: 34,
    shadowColor: "#19ff7f",
    shadowOpacity: 0.22,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 8 },
    elevation: 10,
  },
  previewSurface: {
    height: 174,
    borderRadius: 20,
    backgroundColor: "#26c95b",
    paddingHorizontal: 18,
    paddingTop: 16,
    paddingBottom: 20,
    justifyContent: "space-between",
  },
  previewBadge: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 9,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(0,0,0,0.26)",
  },
  previewBadgeDot: {
    width: 10,
    height: 10,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(255,255,255,0.2)",
  },
  previewBadgeText: {
    color: "#f4fff6",
    fontSize: 18,
    fontWeight: "700",
  },
  previewAvatar: {
    alignSelf: "center",
    width: 110,
    height: 110,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    marginTop: -6,
  },
  previewEyesRow: {
    flexDirection: "row",
    gap: 34,
  },
  previewEyeDot: {
    width: 16,
    height: 16,
    borderRadius: Theme.radius.full,
    backgroundColor: "#eff9ee",
  },
  previewInitial: {
    color: "#ecfff0",
    fontSize: 34,
    fontWeight: "400",
  },
  previewControls: {
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    borderRadius: Theme.radius.full,
    backgroundColor: "rgba(16,20,21,0.82)",
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  controlPill: {
    minWidth: 56,
    borderRadius: Theme.radius.full,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: "rgba(255,255,255,0.06)",
  },
  controlPillActive: {
    backgroundColor: "rgba(61, 224, 120, 0.18)",
  },
  controlPillText: {
    fontSize: 11,
    fontWeight: "700",
  },
  controlPillTextActive: {
    color: "#f5fff7",
  },
  controlPillTextInactive: {
    color: "#d95d62",
  },
  joinPanel: {
    gap: 16,
    marginTop: 10,
  },
  sectionTitle: {
    color: Theme.colors.foreground,
    fontSize: 30,
    fontWeight: "700",
    letterSpacing: -0.8,
  },
  subtitle: {
    color: "#8f96a3",
    fontSize: 16,
    lineHeight: 24,
  },
  input: {
    height: 46,
    borderRadius: 14,
    backgroundColor: "#131927",
    color: Theme.colors.foreground,
    paddingHorizontal: 16,
    fontSize: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
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
    backgroundColor: Theme.colors.primary,
    borderRadius: Theme.radius.full,
    height: 48,
    marginTop: 2,
  },
  primaryButtonText: {
    color: Theme.colors.primaryForeground,
    fontSize: 16,
    fontWeight: "800",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  footer: {
    flex: 1,
    justifyContent: "flex-end",
    alignItems: "center",
    paddingTop: 32,
  },
  footerText: {
    color: "rgba(255,255,255,0.22)",
    fontSize: 12,
    fontWeight: "600",
  },
});
