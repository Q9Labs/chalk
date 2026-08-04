import { useClipboardInviteSuggestion } from "@q9labsai/chalk-react-native/clipboard";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import Add01Icon from "@hugeicons/core-free-icons/dist/esm/Add01Icon";
import Link01Icon from "@hugeicons/core-free-icons/dist/esm/Link01Icon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import ArrowRight02Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight02Icon";
import CancelCircleIcon from "@hugeicons/core-free-icons/dist/esm/CancelCircleIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useMemo, useState, useRef, useEffect } from "react";
import { KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View, Animated, ActivityIndicator, LayoutAnimation } from "react-native";
import * as Clipboard from "expo-clipboard";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { BrandMark } from "../components/BrandMark";
import { ClipboardInviteSuggestion } from "../components/ClipboardInviteSuggestion";
import { enterLocalSpaceRoute, getClipboardSpaceSuggestion, parseSpaceLink, resolveSpaceInvite, type SpaceRoute } from "../lib/spaces";

interface HomeScreenProps {
  onNavigate: (route: SpaceRoute) => void;
  onDiagnosticsFailure?: (source: "resolve-space-link" | "enter-space", message: string) => void;
}

export function HomeScreenIosPad({ onNavigate, onDiagnosticsFailure }: HomeScreenProps): React.JSX.Element {
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
    Animated.stagger(200, [
      Animated.spring(entryHeroAnim, {
        toValue: 1,
        tension: 20,
        friction: 7,
        useNativeDriver: true,
      }),
      Animated.spring(entryActionsAnim, {
        toValue: 1,
        tension: 20,
        friction: 7,
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
      duration: 200,
      create: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
      update: { type: LayoutAnimation.Types.spring, springDamping: 0.8 },
      delete: { type: LayoutAnimation.Types.easeInEaseOut, property: LayoutAnimation.Properties.opacity },
    });
    setActiveMode(mode);
    if (mode === "naming") {
      setTimeout(() => namingInputRef.current?.focus(), 100);
    }
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <KeyboardAvoidingView behavior="padding" style={styles.flex}>
        <View style={styles.content}>
          <Animated.View
            style={[
              styles.heroSection,
              {
                opacity: entryHeroAnim,
                transform: [
                  {
                    translateY: entryHeroAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [20, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <View style={styles.illustrationFrame}>
              <View style={styles.glow} />
              <BrandMark size={120} />
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
                      outputRange: [30, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <View style={styles.commandSurface}>
              {activeMode === "dual" ? (
                <>
                  <Pressable disabled={isEnteringSpace} onPress={() => switchMode("naming")} accessibilityRole="button" accessibilityLabel="Enter the local Space" style={({ pressed }) => [styles.enterSpaceAction, pressed && styles.buttonPressed]}>
                    <HugeiconsIcon icon={Add01Icon} size={24} color={Theme.colors.primary} />
                    <Text style={styles.actionLabel}>Enter Space</Text>
                  </Pressable>

                  <View style={styles.divider} />

                  <View style={[styles.joinContainer, isInputFocused && styles.joinContainerFocused]}>
                    <HugeiconsIcon icon={Link01Icon} size={24} color={isInputFocused ? Theme.colors.primary : Theme.colors.mutedForeground} style={styles.inputIcon} />
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
                      {isResolving ? <ActivityIndicator color="white" size="small" /> : <HugeiconsIcon icon={ArrowRight02Icon} size={24} color={canOpenSpaceLink ? "white" : Theme.colors.mutedForeground} />}
                    </Pressable>
                  </View>
                </>
              ) : (
                <View style={styles.namingModeContainer}>
                  <Pressable onPress={() => switchMode("dual")} style={({ pressed }) => [styles.backModeButton, pressed && styles.buttonPressed]}>
                    <HugeiconsIcon icon={ArrowLeft01Icon} size={24} color={Theme.colors.mutedForeground} />
                  </Pressable>

                  <View style={styles.namingModeInputWrapper}>
                    <TextInput ref={namingInputRef} onChangeText={setSpaceLabel} placeholder="Space label (optional)" placeholderTextColor="rgba(255,255,255,0.3)" style={styles.namingModeInput} value={spaceLabel} onSubmitEditing={() => void handleEnterSpace()} maxLength={40} />
                    {spaceLabel.length > 0 && (
                      <Pressable onPress={() => setSpaceLabel("")} style={({ pressed }) => [styles.clearButton, pressed && styles.buttonPressed]}>
                        <HugeiconsIcon icon={CancelCircleIcon} size={20} color={Theme.colors.mutedForeground} />
                      </Pressable>
                    )}
                  </View>

                  <Pressable onPress={() => void handleEnterSpace()} disabled={isEnteringSpace} style={({ pressed }) => [styles.goButton, styles.goButtonReady, pressed && styles.buttonPressed, isEnteringSpace && styles.buttonDisabled]}>
                    {isEnteringSpace ? <ActivityIndicator color="white" size="small" /> : <HugeiconsIcon icon={ArrowRight02Icon} size={24} color="white" />}
                  </Pressable>
                </View>
              )}
            </View>

            {clipboardSpaceLink && activeMode === "dual" && (
              <View style={styles.clipboardSection}>
                <ClipboardInviteSuggestion isLoading={isResolving} onPress={() => void handleClipboardSuggestion()} />
              </View>
            )}

            {error ? (
              <View style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}
          </Animated.View>
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
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 40,
  },
  heroSection: {
    alignItems: "center",
    marginBottom: 64,
  },
  illustrationFrame: {
    width: 200,
    height: 200,
    borderRadius: 100,
    backgroundColor: "rgba(27, 182, 166, 0.04)",
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 32,
    position: "relative",
    borderWidth: 1,
    borderColor: "rgba(27, 182, 166, 0.08)",
  },
  glow: {
    position: "absolute",
    width: 140,
    height: 140,
    borderRadius: 70,
    backgroundColor: Theme.colors.primary,
    opacity: 0.08,
  },
  heroTitle: {
    fontSize: 42,
    fontWeight: "800",
    color: Theme.colors.foreground,
    textAlign: "center",
    marginBottom: 16,
    letterSpacing: -1,
  },
  heroSubtitle: {
    fontSize: 18,
    color: Theme.colors.mutedForeground,
    textAlign: "center",
    lineHeight: 28,
    maxWidth: 500,
  },
  actionsContainer: {
    width: "100%",
    maxWidth: 900,
    gap: 24,
  },
  commandSurface: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderRadius: 24,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    padding: 8,
    height: 80,
  },
  enterSpaceAction: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 24,
    height: "100%",
    gap: 12,
  },
  actionLabel: {
    color: Theme.colors.primary,
    fontSize: 18,
    fontWeight: "700",
  },
  divider: {
    width: 1,
    height: 40,
    backgroundColor: "rgba(255, 255, 255, 0.1)",
    marginHorizontal: 8,
  },
  joinContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: 16,
    height: "100%",
  },
  joinContainerFocused: {
    backgroundColor: "rgba(27, 182, 166, 0.04)",
    borderRadius: 16,
  },
  inputIcon: {
    marginRight: 4,
  },
  input: {
    flex: 1,
    color: Theme.colors.foreground,
    fontSize: 18,
    fontWeight: "600",
    paddingHorizontal: 12,
  },
  goButton: {
    width: 56,
    height: 56,
    borderRadius: 18,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    alignItems: "center",
    justifyContent: "center",
  },
  goButtonReady: {
    backgroundColor: Theme.colors.primary,
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 4,
  },
  clearButton: {
    padding: 8,
    marginRight: 8,
  },
  buttonPressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.9,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  clipboardSection: {
    width: "100%",
    maxWidth: 600,
    alignSelf: "center",
  },
  errorContainer: {
    maxWidth: 600,
    width: "100%",
    alignSelf: "center",
    borderRadius: 20,
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.2)",
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  errorText: {
    color: Theme.colors.error,
    fontSize: 15,
    fontWeight: "600",
    textAlign: "center",
  },
  namingModeContainer: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 8,
    height: "100%",
  },
  backModeButton: {
    padding: 16,
  },
  namingModeInputWrapper: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  namingModeInput: {
    flex: 1,
    color: "white",
    fontSize: 20,
    fontWeight: "700",
    paddingHorizontal: 12,
  },
});
