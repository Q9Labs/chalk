import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, SafeAreaView, Linking } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Settings01Icon, KeyboardIcon, Add01Icon } from "@hugeicons/core-free-icons";
import { canCreateMeeting, createMeetingLobbyRoute, getApiUrl, parseInputDestination, resolveJoinToken, type LobbyRoute } from "../lib/chalk";
import { Theme } from "../lib/theme";
import { ChalkLogoElements } from "../components/ChalkLogoElements";
import { ClipboardInviteSuggestion } from "../components/ClipboardInviteSuggestion";
import { useClipboardInviteSuggestion } from "./useClipboardInviteSuggestion";

const PUBLIC_SITE_URL = "https://chalkmeet.com";
const PUBLIC_PRIVACY_URL = "https://chalkmeet.com/privacy";

export interface HomeScreenProps {
  onNavigate: (route: LobbyRoute) => void;
  onDiagnosticsFailure?: (source: "resolve-join-link" | "create-meeting", message: string) => void;
}

export function HomeScreen({ onNavigate, onDiagnosticsFailure }: HomeScreenProps): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const createEnabled = useMemo(() => canCreateMeeting(), []);
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isCreatingMeeting, setIsCreatingMeeting] = useState(false);
  const inviteDestination = useMemo(() => parseInputDestination(input), [input]);
  const canOpenInviteLink = Boolean(inviteDestination?.joinToken);
  const clipboardInviteLink = useClipboardInviteSuggestion(input);

  const openInviteLink = async (inviteLink: string) => {
    const destination = parseInputDestination(inviteLink);
    const joinToken = destination?.joinToken;
    if (!joinToken) {
      setError("Please paste a valid invite link.");
      return;
    }

    setError(null);

    try {
      setIsResolving(true);
      onNavigate(await resolveJoinToken(joinToken, apiUrl));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Invalid invite link";
      setError(message);
      onDiagnosticsFailure?.("resolve-join-link", message);
    } finally {
      setIsResolving(false);
    }
  };

  const handleOpenInput = async () => {
    await openInviteLink(input);
  };

  const handleClipboardSuggestion = async () => {
    if (!clipboardInviteLink) {
      return;
    }

    setInput(clipboardInviteLink);
    await openInviteLink(clipboardInviteLink);
  };

  const handleNewMeeting = async () => {
    if (!createEnabled) {
      setError("Meeting creation is currently restricted.");
      return;
    }

    try {
      setError(null);
      setIsCreatingMeeting(true);
      onNavigate(await createMeetingLobbyRoute(apiUrl));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Unable to create meeting";
      setError(message);
      onDiagnosticsFailure?.("create-meeting", message);
    } finally {
      setIsCreatingMeeting(false);
    }
  };

  const handleOpenWebsite = () => {
    void Linking.openURL(PUBLIC_SITE_URL);
  };

  const handleOpenPrivacyPolicy = () => {
    void Linking.openURL(PUBLIC_PRIVACY_URL);
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <View style={styles.header}>
          <Text style={styles.brandLogo}>chalk</Text>
          <Pressable style={styles.iconButton}>
            <HugeiconsIcon icon={Settings01Icon} size={22} color={Theme.colors.foreground} />
          </Pressable>
        </View>

        <ScrollView bounces={true} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.heroSection}>
            <View style={styles.illustrationFrame}>
              <View style={styles.glow} />
              <ChalkLogoElements size={100} />
            </View>
            <Text style={styles.heroTitle}>Video meetings for everyone</Text>
            <Text style={styles.heroSubtitle}>Connect, collaborate, and celebrate from anywhere with Chalk.</Text>
          </View>

          <View style={styles.actionSection}>
            <Pressable disabled={!createEnabled || isCreatingMeeting} onPress={() => void handleNewMeeting()} style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed, (!createEnabled || isCreatingMeeting) && styles.buttonDisabled]}>
              <HugeiconsIcon icon={Add01Icon} size={20} color="white" />
              <Text style={styles.primaryButtonText}>{isCreatingMeeting ? "Starting..." : "New meeting"}</Text>
            </Pressable>

            {clipboardInviteLink ? <ClipboardInviteSuggestion isLoading={isResolving} onPress={() => void handleClipboardSuggestion()} /> : null}

            <View style={styles.inputWrapper}>
              <View style={styles.inputContainer}>
                <HugeiconsIcon icon={KeyboardIcon} size={20} color={Theme.colors.mutedForeground} style={styles.inputIcon} />
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onChangeText={(text) => {
                    setInput(text);
                    if (error) setError(null);
                  }}
                  placeholder="Paste invite link"
                  placeholderTextColor={Theme.colors.placeholder}
                  style={styles.input}
                  value={input}
                />
                {input.length > 0 && (
                  <Pressable onPress={() => void handleOpenInput()} style={({ pressed }) => [styles.joinAction, pressed && !isResolving && canOpenInviteLink && styles.buttonPressed, (!canOpenInviteLink || isResolving) && styles.joinActionDisabled]} disabled={!canOpenInviteLink || isResolving}>
                    <Text style={styles.joinActionText}>{isResolving ? "..." : "Open"}</Text>
                  </Pressable>
                )}
              </View>
            </View>

            {error ? (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </View>
        </ScrollView>

        <View style={styles.footer}>
          <Pressable onPress={handleOpenWebsite}>
            <Text style={styles.footerText}>
              Learn more at <Text style={styles.footerLink}>chalkmeet.com</Text>
            </Text>
          </Pressable>
          <Pressable onPress={handleOpenPrivacyPolicy}>
            <Text style={styles.footerText}>
              <Text style={styles.footerLink}>Privacy Policy</Text>
            </Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.colors.background,
  },
  flex: {
    flex: 1,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 24,
    paddingVertical: 20, // Increased to avoid status bar overlap
    marginTop: Platform.OS === "android" ? 10 : 0, // Extra margin for Android
  },
  brandLogo: {
    fontSize: 24,
    fontWeight: "800",
    color: Theme.colors.foreground,
    letterSpacing: -1,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(255,255,255,0.05)",
    alignItems: "center",
    justifyContent: "center",
  },
  scrollContent: {
    paddingHorizontal: 24,
    paddingBottom: 40,
    paddingTop: 20,
  },
  heroSection: {
    alignItems: "center",
    marginBottom: 48,
  },
  illustrationFrame: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(27, 182, 166, 0.05)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 32,
    position: "relative",
  },
  glow: {
    position: "absolute",
    width: 120,
    height: 120,
    borderRadius: 60,
    backgroundColor: Theme.colors.primary,
    opacity: 0.1,
  },
  heroTitle: {
    fontSize: 28,
    fontWeight: "800",
    color: Theme.colors.foreground,
    textAlign: "center",
    marginBottom: 12,
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    fontSize: 16,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
    lineHeight: 24,
    paddingHorizontal: 20,
  },
  actionSection: {
    gap: 16,
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.primary,
    height: 56,
    borderRadius: 16,
    gap: 10,
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 8,
    elevation: 4,
  },
  buttonPressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.9,
  },
  primaryButtonText: {
    color: "white",
    fontSize: 17,
    fontWeight: "700",
  },
  inputWrapper: {
    marginTop: 8,
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.03)",
    borderRadius: 16,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    height: 56,
    paddingHorizontal: 16,
  },
  inputIcon: {
    marginRight: 12,
    marginTop: Platform.OS === "android" ? 2 : 0, // Small adjustment for icon alignment
  },
  input: {
    flex: 1,
    color: Theme.colors.foreground,
    fontSize: 16,
    fontWeight: "500",
    paddingVertical: 0, // Fixes vertical alignment on some platforms
    height: "100%",
  },
  joinAction: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 10,
  },
  joinActionDisabled: {
    opacity: 0.45,
  },
  joinActionText: {
    color: Theme.colors.primary,
    fontWeight: "700",
    fontSize: 14,
  },
  errorContainer: {
    marginTop: 8,
    paddingHorizontal: 4,
  },
  errorText: {
    color: Theme.colors.error,
    fontSize: 13,
    fontWeight: "500",
  },
  footer: {
    paddingVertical: 24,
    alignItems: "center",
    gap: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.03)",
  },
  footerText: {
    color: Theme.colors.mutedForeground,
    fontSize: 13,
  },
  footerLink: {
    color: Theme.colors.primary,
    fontWeight: "600",
  },
  buttonDisabled: {
    opacity: 0.5,
  },
});
