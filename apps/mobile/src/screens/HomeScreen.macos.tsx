import { useClipboardInviteSuggestion } from "@q9labsai/chalk-react-native/clipboard";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import Add01Icon from "@hugeicons/core-free-icons/dist/esm/Add01Icon";
import KeyboardIcon from "@hugeicons/core-free-icons/dist/esm/KeyboardIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import * as Clipboard from "expo-clipboard";
import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrandMark } from "../components/BrandMark";
import { ClipboardInviteSuggestion } from "../components/ClipboardInviteSuggestion";
import { enterLocalSpaceRoute, getClipboardSpaceSuggestion, parseSpaceLink, resolveSpaceInvite, type SpaceRoute } from "../lib/spaces";

const PUBLIC_SITE_URL = "https://chalkmeet.com";
const PUBLIC_PRIVACY_URL = "https://chalkmeet.com/privacy";

interface HomeScreenProps {
  onNavigate: (route: SpaceRoute) => void;
  onDiagnosticsFailure?: (source: "resolve-space-link" | "enter-space", message: string) => void;
}

export function HomeScreenMacos({ onNavigate, onDiagnosticsFailure }: HomeScreenProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isEnteringSpace, setIsEnteringSpace] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const spaceDestination = useMemo(() => parseSpaceLink(input), [input]);
  const canOpenSpaceLink = Boolean(spaceDestination?.spaceInviteToken);
  const clipboardSpaceLink = useClipboardInviteSuggestion(input, {
    clipboard: Clipboard,
    getSuggestion: getClipboardSpaceSuggestion,
  });

  const openSpaceLink = async (spaceLink: string) => {
    const destination = parseSpaceLink(spaceLink);
    const spaceInviteToken = destination?.spaceInviteToken;
    if (!spaceInviteToken) {
      setError("Paste a valid Space link.");
      return;
    }

    setError(null);

    try {
      setIsResolving(true);
      onNavigate(await resolveSpaceInvite(spaceInviteToken));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "The Space link is invalid.";
      setError(message);
      onDiagnosticsFailure?.("resolve-space-link", message);
    } finally {
      setIsResolving(false);
    }
  };

  const handleOpenInput = async () => {
    await openSpaceLink(input);
  };

  const handleClipboardSuggestion = async () => {
    if (!clipboardSpaceLink) {
      return;
    }

    setInput(clipboardSpaceLink);
    await openSpaceLink(clipboardSpaceLink);
  };

  const handleEnterSpace = async () => {
    try {
      setError(null);
      setIsEnteringSpace(true);
      onNavigate(await enterLocalSpaceRoute());
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Unable to open the Space.";
      setError(message);
      onDiagnosticsFailure?.("enter-space", message);
    } finally {
      setIsEnteringSpace(false);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <ScrollView bounces={true} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
          <View style={styles.heroSection}>
            <View style={styles.illustrationFrame}>
              <View style={styles.glow} />
              <BrandMark size={100} />
            </View>
            <Text style={styles.heroTitle}>Spaces for live collaboration</Text>
            <Text style={styles.heroSubtitle}>Join a Space to collaborate in real time with Chalk.</Text>
          </View>

          <View style={styles.actionSection}>
            <Pressable disabled={isEnteringSpace} onPress={() => void handleEnterSpace()} style={({ pressed }) => [styles.primaryButton, pressed && styles.buttonPressed, isEnteringSpace && styles.buttonDisabled]}>
              <HugeiconsIcon icon={Add01Icon} size={20} color="white" />
              <Text style={styles.primaryButtonText}>{isEnteringSpace ? "Preparing..." : "Enter Space"}</Text>
            </Pressable>

            {clipboardSpaceLink ? <ClipboardInviteSuggestion isLoading={isResolving} onPress={() => void handleClipboardSuggestion()} /> : null}

            <View style={styles.inputWrapper}>
              <View style={[styles.inputContainer, isInputFocused && styles.inputContainerFocused]}>
                <HugeiconsIcon icon={KeyboardIcon} size={20} color={isInputFocused ? Theme.colors.primary : Theme.colors.mutedForeground} style={styles.inputIcon} />
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  onFocus={() => setIsInputFocused(true)}
                  onBlur={() => setIsInputFocused(false)}
                  onChangeText={(text) => {
                    setInput(text);
                    if (error) {
                      setError(null);
                    }
                  }}
                  placeholder="Paste a Space link"
                  placeholderTextColor={Theme.colors.placeholder}
                  style={styles.input}
                  value={input}
                />
                <Pressable onPress={() => void handleOpenInput()} style={({ pressed }) => [styles.joinAction, pressed && !isResolving && canOpenSpaceLink && styles.buttonPressed, (!canOpenSpaceLink || isResolving) && styles.joinActionDisabled]} disabled={!canOpenSpaceLink || isResolving}>
                  <Text style={styles.joinActionText}>{isResolving ? "..." : "Join"}</Text>
                </Pressable>
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
          <Pressable onPress={() => void Linking.openURL(PUBLIC_SITE_URL)}>
            <Text style={styles.footerText}>
              Learn more at <Text style={styles.footerLink}>chalkmeet.com</Text>
            </Text>
          </Pressable>
          <Pressable onPress={() => void Linking.openURL(PUBLIC_PRIVACY_URL)}>
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
    width: 160,
    height: 160,
    borderRadius: 80,
    backgroundColor: "rgba(27, 182, 166, 0.04)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 28,
    position: "relative",
    borderWidth: 1,
    borderColor: "rgba(27, 182, 166, 0.08)",
  },
  glow: {
    position: "absolute",
    width: 100,
    height: 100,
    borderRadius: 50,
    backgroundColor: Theme.colors.primary,
    opacity: 0.08,
  },
  heroTitle: {
    fontSize: 26,
    fontWeight: "800",
    color: Theme.colors.foreground,
    textAlign: "center",
    marginBottom: 10,
    letterSpacing: -0.5,
  },
  heroSubtitle: {
    fontSize: 15,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
    lineHeight: 22,
    paddingHorizontal: 24,
  },
  actionSection: {
    gap: 16,
  },
  primaryButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.primary,
    height: 54,
    borderRadius: 16,
    gap: 8,
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.2,
    shadowRadius: 10,
    elevation: 4,
  },
  buttonPressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.85,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  primaryButtonText: {
    color: "white",
    fontSize: 16,
    fontWeight: "700",
  },
  helperText: {
    color: Theme.colors.mutedForeground,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 10,
  },
  inputWrapper: {
    marginTop: 8,
  },
  inputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.04)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    height: 58,
    paddingHorizontal: 16,
  },
  inputContainerFocused: {
    borderColor: Theme.colors.primary,
    backgroundColor: "rgba(27, 182, 166, 0.04)",
  },
  inputIcon: {
    marginRight: 12,
  },
  input: {
    flex: 1,
    color: Theme.colors.foreground,
    fontSize: 15,
    fontWeight: "600",
  },
  joinAction: {
    minWidth: 58,
    height: 38,
    borderRadius: 12,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 14,
  },
  joinActionDisabled: {
    opacity: 0.5,
  },
  joinActionText: {
    color: "white",
    fontSize: 13,
    fontWeight: "800",
    textTransform: "uppercase",
  },
  errorContainer: {
    borderRadius: 14,
    backgroundColor: "rgba(239,68,68,0.08)",
    borderWidth: 1,
    borderColor: "rgba(239,68,68,0.14)",
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  errorText: {
    color: Theme.colors.error,
    fontSize: 13,
    fontWeight: "600",
    textAlign: "center",
  },
  footer: {
    paddingHorizontal: 24,
    paddingBottom: Platform.OS === "ios" ? 16 : 18,
    paddingTop: 10,
    gap: 6,
  },
  footerText: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    textAlign: "center",
  },
  footerLink: {
    color: Theme.colors.primary,
    fontWeight: "700",
  },
});
