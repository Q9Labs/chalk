import { useClipboardInviteSuggestion } from "@q9labsai/chalk-react-native/clipboard";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import * as Clipboard from "expo-clipboard";
import Add01Icon from "@hugeicons/core-free-icons/dist/esm/Add01Icon";
import Link01Icon from "@hugeicons/core-free-icons/dist/esm/Link01Icon";
import ArrowRight02Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight02Icon";
import CancelCircleIcon from "@hugeicons/core-free-icons/dist/esm/CancelCircleIcon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useMemo, useState, useRef, useEffect } from "react";
import { KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, Animated, ActivityIndicator, LayoutAnimation } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrandMark } from "../components/BrandMark";
import { ClipboardInviteSuggestion } from "../components/ClipboardInviteSuggestion";
import { enterLocalSpaceRoute, getClipboardSpaceSuggestion, parseSpaceLink, resolveSpaceInvite, type SpaceRoute } from "../lib/spaces";

const PUBLIC_SITE_URL = "https://chalkmeet.com";
const PUBLIC_PRIVACY_URL = "https://chalkmeet.com/privacy";

export interface HomeScreenProps {
  onNavigate: (route: SpaceRoute) => void;
  onDiagnosticsFailure?: (source: "resolve-space-link" | "enter-space", message: string) => void;
}

export function HomeScreenShared({ onNavigate, onDiagnosticsFailure }: HomeScreenProps): React.JSX.Element {
  const [input, setInput] = useState("");
  const [spaceLabel, setSpaceLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isEnteringSpace, setIsEnteringSpace] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [activeMode, setActiveMode] = useState<"dual" | "naming">("dual");
  const inputRef = useRef<TextInput>(null);
  const namingInputRef = useRef<TextInput>(null);

  const spaceDestination = useMemo(() => parseSpaceLink(input), [input]);
  const canOpenSpaceLink = Boolean(spaceDestination?.spaceInviteToken);
  const clipboardSpaceLink = useClipboardInviteSuggestion(input, {
    clipboard: Clipboard,
    getSuggestion: getClipboardSpaceSuggestion,
  });

  const entryHeroAnim = useRef(new Animated.Value(0)).current;
  const entryActionsAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.stagger(150, [
      Animated.spring(entryHeroAnim, {
        toValue: 1,
        tension: 40,
        friction: 8,
        useNativeDriver: true,
      }),
      Animated.spring(entryActionsAnim, {
        toValue: 1,
        tension: 30,
        friction: 8,
        useNativeDriver: true,
      }),
    ]).start();
  }, [entryHeroAnim, entryActionsAnim]);

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
    if (!clipboardSpaceLink) return;
    setInput(clipboardSpaceLink);
    await openSpaceLink(clipboardSpaceLink);
  };

  const handleEnterSpace = async () => {
    try {
      setError(null);
      setIsEnteringSpace(true);
      onNavigate(await enterLocalSpaceRoute(spaceLabel.trim() || undefined));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Unable to open the Space.";
      setError(message);
      onDiagnosticsFailure?.("enter-space", message);
    } finally {
      setIsEnteringSpace(false);
    }
  };

  const switchMode = (mode: "dual" | "naming") => {
    LayoutAnimation.configureNext({
      duration: 300,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.spring, springDamping: 0.7 },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    setActiveMode(mode);
    if (mode === "naming") {
      setTimeout(() => namingInputRef.current?.focus(), 150);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <ScrollView bounces={true} contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false} keyboardShouldPersistTaps="handled">
          <Animated.View
            style={[
              styles.heroSection,
              {
                opacity: entryHeroAnim,
                transform: [
                  {
                    translateY: entryHeroAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [30, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <View style={styles.illustrationFrame}>
              <View style={styles.glow} />
              <View style={styles.innerGlow} />
              <BrandMark size={110} />
            </View>
            <Text style={styles.heroTitle}>Spaces for live collaboration</Text>
            <Text style={styles.heroSubtitle}>Join a Space to collaborate in real time with Chalk.</Text>
          </Animated.View>

          <Animated.View
            style={[
              styles.actionsContainer,
              {
                opacity: entryActionsAnim,
                transform: [
                  {
                    translateY: entryActionsAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [40, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            {activeMode === "dual" ? (
              <>
                <Pressable disabled={isEnteringSpace} onPress={() => switchMode("naming")} accessibilityRole="button" accessibilityLabel="Enter the local Space" style={({ pressed }) => [styles.localSpaceButton, pressed && styles.buttonPressed, isEnteringSpace && styles.buttonDisabled]}>
                  <HugeiconsIcon icon={Add01Icon} size={24} color="white" />
                  <Text style={styles.localSpaceButtonText}>{isEnteringSpace ? "Preparing..." : "Enter Space"}</Text>
                </Pressable>

                {/* Join Input Section */}
                <View style={styles.joinSection}>
                  <View style={[styles.joinContainer, isInputFocused && styles.joinContainerFocused]}>
                    <HugeiconsIcon icon={Link01Icon} size={20} color={isInputFocused ? Theme.colors.primary : Theme.colors.mutedForeground} style={styles.inputIcon} />
                    <TextInput
                      ref={inputRef}
                      autoCapitalize="none"
                      autoCorrect={false}
                      onFocus={() => setIsInputFocused(true)}
                      onBlur={() => setIsInputFocused(false)}
                      onChangeText={(text) => {
                        setInput(text);
                        if (error) setError(null);
                      }}
                      placeholder="Paste a Space link"
                      placeholderTextColor={Theme.colors.placeholder}
                      style={styles.input}
                      value={input}
                      onSubmitEditing={() => void handleOpenInput()}
                    />

                    {input.length > 0 && (
                      <Pressable onPress={() => setInput("")} style={({ pressed }) => [styles.clearButton, pressed && styles.buttonPressed]}>
                        <HugeiconsIcon icon={CancelCircleIcon} size={20} color={Theme.colors.mutedForeground} />
                      </Pressable>
                    )}

                    <Pressable onPress={() => void handleOpenInput()} disabled={!canOpenSpaceLink || isResolving} style={({ pressed }) => [styles.goButton, canOpenSpaceLink && styles.goButtonReady, pressed && canOpenSpaceLink && styles.buttonPressed, isResolving && styles.buttonDisabled]}>
                      {isResolving ? <ActivityIndicator color="white" size="small" /> : <HugeiconsIcon icon={ArrowRight02Icon} size={22} color={canOpenSpaceLink ? "white" : Theme.colors.mutedForeground} />}
                    </Pressable>
                  </View>
                </View>
              </>
            ) : (
              /* Naming Mode */
              <View style={styles.namingModeContainer}>
                <View style={styles.namingModeHeader}>
                  <Pressable onPress={() => switchMode("dual")} style={({ pressed }) => [styles.backButton, pressed && styles.buttonPressed]}>
                    <HugeiconsIcon icon={ArrowLeft01Icon} size={24} color={Theme.colors.mutedForeground} />
                  </Pressable>
                  <Text style={styles.namingModeTitle}>Enter the local Space</Text>
                  <View style={styles.backButtonPlaceholder} />
                </View>

                <View style={[styles.namingInputContainer, styles.joinContainerFocused]}>
                  <TextInput ref={namingInputRef} onChangeText={setSpaceLabel} placeholder="Space label (optional)" placeholderTextColor={Theme.colors.placeholder} style={styles.namingInput} value={spaceLabel} onSubmitEditing={() => void handleEnterSpace()} maxLength={40} autoFocus />
                  {spaceLabel.length > 0 && (
                    <Pressable onPress={() => setSpaceLabel("")} style={({ pressed }) => [styles.clearButton, pressed && styles.buttonPressed]}>
                      <HugeiconsIcon icon={CancelCircleIcon} size={20} color={Theme.colors.mutedForeground} />
                    </Pressable>
                  )}
                </View>

                <Pressable onPress={() => void handleEnterSpace()} disabled={isEnteringSpace} style={({ pressed }) => [styles.enterSpaceButton, pressed && styles.buttonPressed, isEnteringSpace && styles.buttonDisabled]}>
                  {isEnteringSpace ? (
                    <ActivityIndicator color="white" size="small" />
                  ) : (
                    <>
                      <Text style={styles.enterSpaceButtonText}>Enter Space</Text>
                      <HugeiconsIcon icon={ArrowRight02Icon} size={20} color="white" />
                    </>
                  )}
                </Pressable>
              </View>
            )}

            {/* Clipboard Suggestion */}
            {clipboardSpaceLink && activeMode === "dual" && (
              <View style={styles.clipboardSection}>
                <ClipboardInviteSuggestion isLoading={isResolving} onPress={() => void handleClipboardSuggestion()} />
              </View>
            )}

            {/* Error Display */}
            {error ? (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </Animated.View>
        </ScrollView>

        {/* Footer */}
        {activeMode === "dual" && (
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
        )}
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
    paddingHorizontal: Theme.spacing["2xl"],
    paddingBottom: Theme.spacing["5xl"],
    paddingTop: Theme.spacing["2xl"],
  },
  heroSection: {
    alignItems: "center",
    marginBottom: Theme.spacing["6xl"],
    marginTop: Theme.spacing.xl,
  },
  illustrationFrame: {
    width: 180,
    height: 180,
    borderRadius: 90,
    backgroundColor: "rgba(27, 182, 166, 0.03)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: Theme.spacing["3xl"],
    position: "relative",
    borderWidth: 1,
    borderColor: "rgba(27, 182, 166, 0.1)",
  },
  glow: {
    position: "absolute",
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: Theme.colors.primary,
    opacity: 0.06,
  },
  innerGlow: {
    position: "absolute",
    width: 80,
    height: 80,
    borderRadius: 40,
    backgroundColor: Theme.colors.primary,
    opacity: 0.1,
  },
  heroTitle: {
    ...Theme.typography.title,
    color: Theme.colors.foreground,
    textAlign: "center",
    marginBottom: Theme.spacing.sm,
    letterSpacing: -1,
  },
  heroSubtitle: {
    ...Theme.typography.body,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
    paddingHorizontal: Theme.spacing.xl,
  },
  actionsContainer: {
    gap: Theme.spacing.lg,
  },
  localSpaceButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.primary,
    height: 64,
    borderRadius: Theme.radius["2xl"],
    gap: Theme.spacing.sm,
    ...Theme.shadows.md,
    shadowColor: Theme.colors.primary,
  },
  localSpaceButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "700",
  },
  buttonPressed: {
    transform: [{ scale: 0.98 }],
    opacity: 0.9,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  helperText: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
    paddingHorizontal: Theme.spacing.lg,
  },
  joinSection: {
    marginTop: Theme.spacing.sm,
  },
  joinContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Theme.colors.secondary,
    borderRadius: Theme.radius["2xl"],
    borderWidth: 1.5,
    borderColor: Theme.colors.border,
    height: 64,
    paddingHorizontal: Theme.spacing.lg,
  },
  joinContainerFocused: {
    borderColor: Theme.colors.primary,
    backgroundColor: "rgba(27, 182, 166, 0.04)",
  },
  inputIcon: {
    marginRight: Theme.spacing.sm,
  },
  input: {
    flex: 1,
    color: Theme.colors.foreground,
    fontSize: 17,
    fontWeight: "600",
  },
  clearButton: {
    padding: Theme.spacing.xs,
    marginRight: Theme.spacing.xs,
  },
  goButton: {
    width: 48,
    height: 48,
    borderRadius: Theme.radius.xl,
    backgroundColor: Theme.colors.muted,
    alignItems: "center",
    justifyContent: "center",
  },
  goButtonReady: {
    backgroundColor: Theme.colors.primary,
    ...Theme.shadows.sm,
    shadowColor: Theme.colors.primary,
  },
  clipboardSection: {
    marginTop: Theme.spacing.sm,
  },
  errorContainer: {
    borderRadius: Theme.radius.xl,
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.2)",
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.md,
  },
  errorText: {
    ...Theme.typography.label,
    color: Theme.colors.error,
    textAlign: "center",
  },
  namingModeContainer: {
    gap: Theme.spacing.lg,
  },
  namingModeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: Theme.spacing.sm,
  },
  backButton: {
    padding: Theme.spacing.sm,
    marginLeft: -Theme.spacing.sm,
  },
  backButtonPlaceholder: {
    width: 40,
  },
  namingModeTitle: {
    ...Theme.typography.subheading,
    color: Theme.colors.foreground,
  },
  namingInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: Theme.colors.secondary,
    borderRadius: Theme.radius["2xl"],
    borderWidth: 1.5,
    borderColor: Theme.colors.border,
    height: 64,
    paddingHorizontal: Theme.spacing.lg,
  },
  namingInput: {
    flex: 1,
    color: Theme.colors.foreground,
    fontSize: 18,
    fontWeight: "600",
  },
  enterSpaceButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.primary,
    height: 64,
    borderRadius: Theme.radius["2xl"],
    gap: Theme.spacing.sm,
    ...Theme.shadows.md,
    shadowColor: Theme.colors.primary,
    marginTop: Theme.spacing.sm,
  },
  enterSpaceButtonText: {
    color: "white",
    fontSize: 18,
    fontWeight: "700",
  },
  footer: {
    paddingHorizontal: Theme.spacing["2xl"],
    paddingBottom: Platform.OS === "ios" ? Theme.spacing.xl : Theme.spacing["2xl"],
    paddingTop: Theme.spacing.sm,
    gap: Theme.spacing.xs,
  },
  footerText: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
  },
  footerLink: {
    color: Theme.colors.primary,
    fontWeight: "700",
  },
});
