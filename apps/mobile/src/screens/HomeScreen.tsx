import { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { canCreateMeeting, createMeetingLobbyRoute, getApiUrl, parseInputDestination, resolveJoinToken, type LobbyRoute } from "../lib/chalk";
import { Theme } from "../lib/theme";

export interface HomeScreenProps {
  onNavigate: (route: LobbyRoute) => void;
}

export function HomeScreen({ onNavigate }: HomeScreenProps): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const createEnabled = useMemo(() => canCreateMeeting(), []);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  const handleOpenInput = async () => {
    const destination = parseInputDestination(input);
    if (!destination) {
      setError("Paste a Chalk join link or meeting destination.");
      return;
    }

    setError(null);

    if (destination.joinToken) {
      try {
        setIsResolving(true);
        onNavigate(await resolveJoinToken(destination.joinToken, apiUrl));
      } catch (nextError) {
        setError(nextError instanceof Error ? nextError.message : String(nextError));
      } finally {
        setIsResolving(false);
      }
      return;
    }

    onNavigate(destination);
  };

  const handleNewMeeting = () => {
    if (!createEnabled) {
      setError("Create meeting is disabled in this build. Join by link is still available.");
      return;
    }

    setError(null);
    onNavigate(createMeetingLobbyRoute());
  };

  return (
    <ScrollView bounces={false} contentContainerStyle={styles.screen}>
      <View style={styles.hero}>
        <View style={styles.brandRow}>
          <Text style={styles.logo}>CHALK</Text>
          <Text style={styles.versionPill}>meeting-first mobile</Text>
        </View>

        <View style={styles.copyBlock}>
          <Text style={styles.eyebrow}>Official mobile</Text>
          <Text style={styles.title}>Join fast. Stay clear. Keep the room stable.</Text>
          <Text style={styles.body}>
            Mobile V1 is focused on the meeting itself: lobby, room, chat, transcripts, and connection correctness.
          </Text>
        </View>

        <View style={styles.panel}>
          <Text style={styles.panelTitle}>Join a meeting</Text>
          <TextInput
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setInput}
            placeholder="Paste a Chalk join link or room destination"
            placeholderTextColor={Theme.colors.placeholder}
            style={styles.input}
            value={input}
          />
          <Pressable disabled={isResolving || !input.trim()} onPress={() => void handleOpenInput()} style={[styles.secondaryButton, (!input.trim() || isResolving) && styles.buttonDisabled]}>
            <Text style={styles.secondaryButtonText}>{isResolving ? "Resolving..." : "Open lobby"}</Text>
          </Pressable>

          <View style={styles.divider} />

          <Text style={styles.panelTitle}>Start a meeting</Text>
          <Text style={styles.supportingCopy}>
            Creates a host-capable lobby when this build has the Chalk API key configured, matching the web app&apos;s instant meeting model.
          </Text>
          <Pressable disabled={!createEnabled} onPress={handleNewMeeting} style={[styles.primaryButton, !createEnabled && styles.buttonDisabled]}>
            <Text style={styles.primaryButtonText}>{createEnabled ? "Create meeting" : "Create disabled"}</Text>
          </Pressable>

          {error ? <Text style={styles.error}>{error}</Text> : null}
        </View>

        <View style={styles.badgeRow}>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Lobby first</Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Chat + transcript</Text>
          </View>
          <View style={styles.badge}>
            <Text style={styles.badgeText}>Realtime focus</Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flexGrow: 1,
    backgroundColor: Theme.colors.background,
  },
  hero: {
    flex: 1,
    justifyContent: "space-between",
    paddingHorizontal: Theme.spacing["2xl"],
    paddingTop: 64,
    paddingBottom: 40,
    gap: Theme.spacing["3xl"],
  },
  brandRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: Theme.spacing.md,
  },
  logo: {
    color: Theme.colors.foreground,
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 4,
  },
  versionPill: {
    color: Theme.colors.primary,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 1,
  },
  copyBlock: {
    gap: Theme.spacing.lg,
  },
  eyebrow: {
    ...Theme.typography.eyebrow,
    color: Theme.colors.primary,
  },
  title: {
    ...Theme.typography.title,
    color: Theme.colors.foreground,
    fontSize: 36,
    lineHeight: 42,
  },
  body: {
    ...Theme.typography.body,
    color: Theme.colors.mutedForeground,
  },
  panel: {
    backgroundColor: Theme.colors.card,
    borderRadius: Theme.radius["2xl"],
    padding: Theme.spacing.xl,
    gap: Theme.spacing.md,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  panelTitle: {
    ...Theme.typography.subheading,
    color: Theme.colors.foreground,
  },
  input: {
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.secondary,
    color: Theme.colors.foreground,
    paddingHorizontal: 16,
    paddingVertical: 14,
    fontSize: 16,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  secondaryButton: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.secondary,
    borderRadius: Theme.radius.lg,
    paddingVertical: 14,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  secondaryButtonText: {
    color: Theme.colors.foreground,
    fontSize: 15,
    fontWeight: "700",
  },
  primaryButton: {
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.primary,
    borderRadius: Theme.radius.lg,
    paddingVertical: 15,
    ...Theme.shadows.md,
  },
  primaryButtonText: {
    color: Theme.colors.primaryForeground,
    fontSize: 16,
    fontWeight: "800",
  },
  supportingCopy: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
  },
  divider: {
    height: 1,
    backgroundColor: Theme.colors.border,
    marginVertical: Theme.spacing.xs,
  },
  badgeRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Theme.spacing.sm,
  },
  badge: {
    borderRadius: Theme.radius.full,
    paddingHorizontal: 12,
    paddingVertical: 8,
    backgroundColor: "rgba(27, 182, 166, 0.12)",
    borderWidth: 1,
    borderColor: "rgba(27, 182, 166, 0.2)",
  },
  badgeText: {
    color: Theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
  },
  buttonDisabled: {
    opacity: 0.45,
  },
  error: {
    ...Theme.typography.label,
    color: Theme.colors.error,
  },
});
