import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
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
  const previewLabel = useMemo(() => (displayName.trim().charAt(0) || "C").toUpperCase(), [displayName]);

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={styles.screen}>
      <ScrollView bounces={false} contentContainerStyle={styles.content}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>{role === "host" ? "Host lobby" : "Join lobby"}</Text>
          <Text style={styles.title}>{roomName}</Text>
          <Text style={styles.body}>Set your display name and check your audio/video before entering the room.</Text>
        </View>

        <View style={styles.previewCard}>
          <View style={styles.previewAvatar}>
            <Text style={styles.previewAvatarText}>{previewLabel}</Text>
          </View>
          <View style={styles.previewControls}>
            <Pressable onPress={() => setAudioEnabled((current) => !current)} style={[styles.toggle, !audioEnabled && styles.toggleDanger]}>
              <Text style={styles.toggleText}>{audioEnabled ? "Mic on" : "Mic off"}</Text>
            </Pressable>
            <Pressable onPress={() => setVideoEnabled((current) => !current)} style={[styles.toggle, !videoEnabled && styles.toggleDanger]}>
              <Text style={styles.toggleText}>{videoEnabled ? "Cam on" : "Cam off"}</Text>
            </Pressable>
          </View>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Ready when you are</Text>
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
              onJoin({
                displayName,
                audioEnabled,
                videoEnabled,
              })
            }
            style={styles.primaryButton}
          >
            <Text style={styles.primaryButtonText}>{role === "host" ? "Start meeting" : "Join meeting"}</Text>
          </Pressable>
          {onCancel ? (
            <Pressable onPress={onCancel} style={styles.secondaryButton}>
              <Text style={styles.secondaryButtonText}>Back</Text>
            </Pressable>
          ) : null}
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
    paddingHorizontal: Theme.spacing.xl,
    paddingTop: Theme.spacing["6xl"],
    paddingBottom: Theme.spacing["3xl"],
    gap: Theme.spacing["2xl"],
  },
  hero: {
    gap: Theme.spacing.md,
  },
  eyebrow: {
    ...Theme.typography.eyebrow,
    color: Theme.colors.primary,
  },
  title: {
    ...Theme.typography.title,
    color: Theme.colors.foreground,
  },
  body: {
    ...Theme.typography.body,
    color: Theme.colors.mutedForeground,
  },
  previewCard: {
    borderRadius: Theme.radius["2xl"],
    backgroundColor: Theme.colors.stageAccent,
    padding: Theme.spacing["2xl"],
    gap: Theme.spacing.xl,
  },
  previewAvatar: {
    width: 120,
    height: 120,
    alignSelf: "center",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 60,
    backgroundColor: "rgba(255,255,255,0.12)",
  },
  previewAvatarText: {
    color: Theme.colors.foreground,
    fontSize: 44,
    fontWeight: "700",
  },
  previewControls: {
    flexDirection: "row",
    justifyContent: "center",
    gap: Theme.spacing.md,
  },
  toggle: {
    minWidth: 104,
    alignItems: "center",
    borderRadius: Theme.radius.full,
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.md,
    backgroundColor: "rgba(0,0,0,0.68)",
  },
  toggleDanger: {
    backgroundColor: "rgba(239, 68, 68, 0.82)",
  },
  toggleText: {
    color: Theme.colors.foreground,
    fontSize: 13,
    fontWeight: "700",
  },
  panel: {
    borderWidth: 1,
    borderColor: Theme.colors.border,
    borderRadius: Theme.radius["2xl"],
    backgroundColor: Theme.colors.card,
    padding: Theme.spacing.xl,
    gap: Theme.spacing.md,
  },
  panelTitle: {
    ...Theme.typography.subheading,
    color: Theme.colors.foreground,
  },
  input: {
    borderWidth: 1,
    borderColor: Theme.colors.border,
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.secondary,
    color: Theme.colors.foreground,
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: 14,
    fontSize: 16,
  },
  error: {
    ...Theme.typography.meta,
    color: Theme.colors.error,
  },
  primaryButton: {
    alignItems: "center",
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.primary,
    paddingVertical: 14,
  },
  primaryButtonText: {
    color: Theme.colors.primaryForeground,
    fontSize: 16,
    fontWeight: "800",
  },
  secondaryButton: {
    alignItems: "center",
    borderRadius: Theme.radius.lg,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    backgroundColor: Theme.colors.secondary,
    paddingVertical: 14,
  },
  secondaryButtonText: {
    color: Theme.colors.foreground,
    fontSize: 15,
    fontWeight: "700",
  },
});
