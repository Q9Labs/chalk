import Add01Icon from "@hugeicons/core-free-icons/dist/esm/Add01Icon";
import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import ArrowRight02Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight02Icon";
import CancelCircleIcon from "@hugeicons/core-free-icons/dist/esm/CancelCircleIcon";
import Link01Icon from "@hugeicons/core-free-icons/dist/esm/Link01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useClipboardInviteSuggestion } from "@q9labsai/chalk-react-native/clipboard";
import { getClipboardInviteSuggestion } from "@q9labsai/chalk-react-native/invites";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { ClipboardInviteSuggestion } from "../components/ClipboardInviteSuggestion";
import { canCreateMeeting, createMeetingLobbyRoute, parseInputDestination, resolveJoinToken, type LobbyRoute } from "../lib/chalk";
import { useReducedMotion } from "./onboarding-motion";

const PUBLIC_SITE_URL = "https://chalkmeet.com";
const PUBLIC_PRIVACY_URL = "https://chalkmeet.com/privacy";

export interface HomeScreenProps {
  onNavigate: (route: LobbyRoute) => void;
  onDiagnosticsFailure?: (source: "resolve-join-link" | "create-meeting", message: string) => void;
}

export function HomeScreenShared({ onNavigate, onDiagnosticsFailure }: HomeScreenProps): React.JSX.Element {
  const createEnabled = useMemo(() => canCreateMeeting(), []);
  const [input, setInput] = useState("");
  const [newSpaceName, setNewSpaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isCreatingSpace, setIsCreatingSpace] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [activeMode, setActiveMode] = useState<"dual" | "naming">("dual");
  const inputRef = useRef<TextInput>(null);
  const namingInputRef = useRef<TextInput>(null);
  const reducedMotion = useReducedMotion();
  const heroAnimation = useRef(new Animated.Value(0)).current;
  const contentAnimation = useRef(new Animated.Value(0)).current;
  const modeAnimation = useRef(new Animated.Value(1)).current;

  const inviteDestination = useMemo(() => parseInputDestination(input), [input]);
  const canOpenInviteLink = Boolean(inviteDestination?.joinToken);
  const clipboardInviteLink = useClipboardInviteSuggestion(input, {
    clipboard: Clipboard,
    getSuggestion: getClipboardInviteSuggestion,
  });

  useEffect(() => {
    if (reducedMotion) {
      heroAnimation.setValue(1);
      contentAnimation.setValue(1);
      return;
    }

    heroAnimation.setValue(0);
    contentAnimation.setValue(0);
    Animated.stagger(110, [
      Animated.timing(heroAnimation, {
        toValue: 1,
        duration: 360,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(contentAnimation, {
        toValue: 1,
        duration: 420,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [contentAnimation, heroAnimation, reducedMotion]);

  useEffect(() => {
    if (reducedMotion) {
      modeAnimation.setValue(1);
      return;
    }

    modeAnimation.setValue(0);
    const animation = Animated.timing(modeAnimation, {
      toValue: 1,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [activeMode, modeAnimation, reducedMotion]);

  useEffect(() => {
    if (activeMode !== "naming") return;
    const focusTimer = setTimeout(() => namingInputRef.current?.focus(), 180);
    return () => clearTimeout(focusTimer);
  }, [activeMode]);

  const openInviteLink = useCallback(
    async (inviteLink: string) => {
      const destination = parseInputDestination(inviteLink);
      const joinToken = destination?.joinToken;
      if (!joinToken) {
        setError("Paste a valid invite link to join this Space.");
        return;
      }

      setError(null);
      try {
        setIsResolving(true);
        onNavigate(await resolveJoinToken(joinToken));
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : "This invite link could not be opened.";
        setError(message);
        onDiagnosticsFailure?.("resolve-join-link", message);
      } finally {
        setIsResolving(false);
      }
    },
    [onDiagnosticsFailure, onNavigate],
  );

  const handleClipboardSuggestion = useCallback(async () => {
    if (!clipboardInviteLink) return;
    setInput(clipboardInviteLink);
    await openInviteLink(clipboardInviteLink);
  }, [clipboardInviteLink, openInviteLink]);

  const handleCreateSpace = useCallback(async () => {
    if (!createEnabled) {
      setError(null);
      void Linking.openURL(PUBLIC_SITE_URL);
      return;
    }

    try {
      setError(null);
      setIsCreatingSpace(true);
      onNavigate(await createMeetingLobbyRoute(newSpaceName.trim() || undefined));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Unable to create this Space.";
      setError(message);
      onDiagnosticsFailure?.("create-meeting", message);
    } finally {
      setIsCreatingSpace(false);
    }
  }, [createEnabled, newSpaceName, onDiagnosticsFailure, onNavigate]);

  const switchMode = useCallback((mode: "dual" | "naming") => {
    setError(null);
    setActiveMode(mode);
  }, []);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <ScrollView bounces contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Animated.View style={[styles.header, { opacity: heroAnimation, transform: [{ translateY: heroAnimation.interpolate({ inputRange: [0, 1], outputRange: [16, 0] }) }] }]}>
            <ChalkWordmark />
            <View style={styles.headerRule} />
            <Text style={styles.headerLabel}>Spaces</Text>
          </Animated.View>

          <Animated.View style={[styles.hero, { opacity: heroAnimation, transform: [{ translateY: heroAnimation.interpolate({ inputRange: [0, 1], outputRange: [18, 0] }) }] }]}>
            <Text style={styles.eyebrow}>YOUR WORK, TOGETHER</Text>
            <Text style={styles.heroTitle}>A Space for{`\n`}work in motion.</Text>
            <Text style={styles.heroSubtitle}>Create a Space or join one with an invite link. Your Spaces and living work stay close at hand.</Text>
          </Animated.View>

          <Animated.View style={[styles.content, { opacity: contentAnimation, transform: [{ translateY: contentAnimation.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }] }]}>
            {activeMode === "dual" ? (
              <>
                <View style={styles.createCard}>
                  <View style={styles.cardIcon}>
                    <HugeiconsIcon color={Theme.colors.primaryForeground} icon={Add01Icon} size={23} />
                  </View>
                  <View style={styles.cardCopy}>
                    <Text style={styles.cardTitle}>Create a Space</Text>
                    <Text style={styles.cardDescription}>A calm place for people, chat, and shared work.</Text>
                  </View>
                  <Pressable
                    accessibilityLabel="Create a Space"
                    accessibilityRole="button"
                    disabled={isCreatingSpace}
                    onPress={() => (createEnabled ? switchMode("naming") : void handleCreateSpace())}
                    style={({ pressed }) => [styles.createButton, pressed && styles.buttonPressed, isCreatingSpace && styles.buttonDisabled]}
                  >
                    <Text style={styles.createButtonText}>{createEnabled ? "Create" : "Create on web"}</Text>
                    <HugeiconsIcon color={Theme.colors.primaryForeground} icon={ArrowRight02Icon} size={19} />
                  </Pressable>
                </View>

                {!createEnabled ? <Text style={styles.helperText}>Invite links still work in mobile. Create your Space on the web.</Text> : null}

                <View style={styles.joinSection}>
                  <View style={styles.sectionHeading}>
                    <Text style={styles.sectionTitle}>Join a Space</Text>
                    <Text style={styles.sectionMeta}>Have an invite?</Text>
                  </View>
                  <View style={[styles.joinContainer, isInputFocused && styles.joinContainerFocused]}>
                    <HugeiconsIcon color={isInputFocused ? Theme.colors.primary : Theme.colors.mutedForeground} icon={Link01Icon} size={20} />
                    <TextInput
                      ref={inputRef}
                      accessibilityLabel="Invite link"
                      autoCapitalize="none"
                      autoCorrect={false}
                      onBlur={() => setIsInputFocused(false)}
                      onChangeText={(text) => {
                        setInput(text);
                        if (error) setError(null);
                      }}
                      onFocus={() => setIsInputFocused(true)}
                      onSubmitEditing={() => void openInviteLink(input)}
                      placeholder="Paste invite link"
                      placeholderTextColor={Theme.colors.mutedForeground}
                      style={styles.input}
                      value={input}
                    />
                    {input.length > 0 ? (
                      <Pressable accessibilityLabel="Clear invite link" accessibilityRole="button" hitSlop={8} onPress={() => setInput("")} style={({ pressed }) => [styles.clearButton, pressed && styles.buttonPressed]}>
                        <HugeiconsIcon color={Theme.colors.mutedForeground} icon={CancelCircleIcon} size={19} />
                      </Pressable>
                    ) : null}
                    <Pressable
                      accessibilityLabel="Join Space"
                      accessibilityRole="button"
                      disabled={!canOpenInviteLink || isResolving}
                      onPress={() => void openInviteLink(input)}
                      style={({ pressed }) => [styles.joinButton, canOpenInviteLink && styles.joinButtonReady, pressed && canOpenInviteLink && styles.buttonPressed, isResolving && styles.buttonDisabled]}
                    >
                      {isResolving ? <ActivityIndicator color={Theme.colors.primaryForeground} size="small" /> : <HugeiconsIcon color={canOpenInviteLink ? Theme.colors.primaryForeground : Theme.colors.mutedForeground} icon={ArrowRight02Icon} size={20} />}
                    </Pressable>
                  </View>
                </View>
              </>
            ) : (
              <Animated.View style={[styles.namingCard, { opacity: modeAnimation, transform: [{ translateY: modeAnimation.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) }] }]}>
                <View style={styles.namingHeader}>
                  <Pressable accessibilityLabel="Back to Spaces" accessibilityRole="button" hitSlop={8} onPress={() => switchMode("dual")} style={({ pressed }) => [styles.backButton, pressed && styles.buttonPressed]}>
                    <HugeiconsIcon color={Theme.colors.foreground} icon={ArrowLeft01Icon} size={22} />
                  </Pressable>
                  <View style={styles.namingHeaderCopy}>
                    <Text style={styles.cardTitle}>Create a Space</Text>
                    <Text style={styles.cardDescription}>Give this Space a name or start with the default.</Text>
                  </View>
                </View>
                <Text style={styles.fieldLabel}>
                  Space name <Text style={styles.optionalLabel}>Optional</Text>
                </Text>
                <View style={styles.namingInputContainer}>
                  <TextInput
                    ref={namingInputRef}
                    accessibilityLabel="Space name"
                    autoCapitalize="sentences"
                    autoCorrect
                    maxLength={64}
                    onChangeText={setNewSpaceName}
                    onSubmitEditing={() => void handleCreateSpace()}
                    placeholder="e.g. Product design"
                    placeholderTextColor={Theme.colors.mutedForeground}
                    returnKeyType="go"
                    style={styles.namingInput}
                    value={newSpaceName}
                  />
                  {newSpaceName.length > 0 ? (
                    <Pressable accessibilityLabel="Clear Space name" accessibilityRole="button" hitSlop={8} onPress={() => setNewSpaceName("")} style={({ pressed }) => [styles.clearButton, pressed && styles.buttonPressed]}>
                      <HugeiconsIcon color={Theme.colors.mutedForeground} icon={CancelCircleIcon} size={19} />
                    </Pressable>
                  ) : null}
                </View>
                <Pressable accessibilityLabel="Create Space" accessibilityRole="button" disabled={isCreatingSpace} onPress={() => void handleCreateSpace()} style={({ pressed }) => [styles.primaryAction, pressed && styles.buttonPressed, isCreatingSpace && styles.buttonDisabled]}>
                  {isCreatingSpace ? (
                    <ActivityIndicator color={Theme.colors.primaryForeground} size="small" />
                  ) : (
                    <>
                      <Text style={styles.primaryActionText}>{createEnabled ? "Create Space" : "Create on web"}</Text>
                      <HugeiconsIcon color={Theme.colors.primaryForeground} icon={ArrowRight02Icon} size={20} />
                    </>
                  )}
                </Pressable>
              </Animated.View>
            )}

            {clipboardInviteLink && activeMode === "dual" ? (
              <View style={styles.clipboardSection}>
                <ClipboardInviteSuggestion isLoading={isResolving} onPress={() => void handleClipboardSuggestion()} />
              </View>
            ) : null}

            {error ? (
              <View accessibilityLiveRegion="assertive" style={styles.errorContainer}>
                <Text style={styles.errorText}>{error}</Text>
              </View>
            ) : null}

            {activeMode === "dual" ? (
              <View style={styles.emptyState}>
                <View style={styles.emptyStateRule} />
                <Text style={styles.emptyStateTitle}>Spaces you join will appear here.</Text>
                <Text style={styles.emptyStateDescription}>Your next Space is always one invite away.</Text>
              </View>
            ) : null}
          </Animated.View>
        </ScrollView>

        {activeMode === "dual" ? (
          <View style={styles.footer}>
            <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(PUBLIC_SITE_URL)}>
              <Text style={styles.footerText}>
                Learn more at <Text style={styles.footerLink}>chalkmeet.com</Text>
              </Text>
            </Pressable>
            <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(PUBLIC_PRIVACY_URL)}>
              <Text style={styles.footerText}>
                <Text style={styles.footerLink}>Privacy Policy</Text>
              </Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function ChalkWordmark(): React.JSX.Element {
  return (
    <View accessibilityLabel="Chalk" style={styles.wordmark}>
      <View style={styles.wordmarkMark}>
        <View style={[styles.wordmarkBar, styles.wordmarkGreen]} />
        <View style={[styles.wordmarkBar, styles.wordmarkYellow]} />
        <View style={[styles.wordmarkBar, styles.wordmarkBlue]} />
        <View style={[styles.wordmarkBar, styles.wordmarkPink]} />
      </View>
      <Text style={styles.wordmarkText}>chalk</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.colors.background },
  flex: { flex: 1 },
  scrollContent: { paddingHorizontal: Theme.spacing["2xl"], paddingTop: Theme.spacing.lg, paddingBottom: Theme.spacing["4xl"] },
  header: { minHeight: 44, flexDirection: "row", alignItems: "center" },
  wordmark: { flexDirection: "row", alignItems: "center", gap: Theme.spacing.sm },
  wordmarkMark: { width: 29, height: 28, flexDirection: "row", alignItems: "flex-end", gap: 2 },
  wordmarkBar: { width: 5, borderRadius: 3 },
  wordmarkGreen: { height: 20, backgroundColor: Theme.colors.chalkGreen, transform: [{ rotate: "-16deg" }] },
  wordmarkYellow: { height: 24, backgroundColor: Theme.colors.chalkYellow, transform: [{ rotate: "-5deg" }] },
  wordmarkBlue: { height: 28, backgroundColor: Theme.colors.chalkBlue, transform: [{ rotate: "16deg" }] },
  wordmarkPink: { height: 23, backgroundColor: Theme.colors.chalkPink, transform: [{ rotate: "8deg" }] },
  wordmarkText: { color: Theme.colors.foreground, fontSize: 22, fontWeight: "800", letterSpacing: -0.8 },
  headerRule: { width: 1, height: 20, backgroundColor: Theme.colors.border, marginHorizontal: Theme.spacing.md },
  headerLabel: { ...Theme.typography.label, color: Theme.colors.mutedForeground },
  hero: { marginTop: Theme.spacing["5xl"], marginBottom: Theme.spacing["3xl"] },
  eyebrow: { ...Theme.typography.eyebrow, color: Theme.colors.mutedForeground, marginBottom: Theme.spacing.md },
  heroTitle: { ...Theme.typography.title, color: Theme.colors.foreground, fontSize: 40, lineHeight: 45, letterSpacing: -1.4 },
  heroSubtitle: { ...Theme.typography.body, color: Theme.colors.mutedForeground, fontSize: 16, lineHeight: 24, marginTop: Theme.spacing.lg, maxWidth: 360 },
  content: { gap: Theme.spacing.lg },
  createCard: { borderWidth: 1, borderColor: Theme.colors.border, borderRadius: Theme.radius.lg, backgroundColor: Theme.colors.card, padding: Theme.spacing.lg, ...Theme.shadows.sm },
  cardIcon: { width: 42, height: 42, borderRadius: Theme.radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: Theme.colors.primary, marginBottom: Theme.spacing.md },
  cardCopy: { marginBottom: Theme.spacing.lg },
  cardTitle: { ...Theme.typography.subheading, color: Theme.colors.foreground, fontSize: 19 },
  cardDescription: { ...Theme.typography.body, color: Theme.colors.mutedForeground, marginTop: Theme.spacing.xs, lineHeight: 21 },
  createButton: { minHeight: 46, borderRadius: Theme.radius.sm, backgroundColor: Theme.colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Theme.spacing.sm, paddingHorizontal: Theme.spacing.lg },
  createButtonText: { ...Theme.typography.label, color: Theme.colors.primaryForeground, fontSize: 15 },
  helperText: { ...Theme.typography.meta, color: Theme.colors.mutedForeground, textAlign: "center", marginTop: -Theme.spacing.sm },
  joinSection: { gap: Theme.spacing.sm },
  sectionHeading: { flexDirection: "row", alignItems: "baseline", justifyContent: "space-between" },
  sectionTitle: { ...Theme.typography.subheading, color: Theme.colors.foreground, fontSize: 18 },
  sectionMeta: { ...Theme.typography.meta, color: Theme.colors.mutedForeground },
  joinContainer: { minHeight: 58, flexDirection: "row", alignItems: "center", gap: Theme.spacing.sm, paddingLeft: Theme.spacing.lg, paddingRight: Theme.spacing.xs, borderWidth: 1, borderColor: Theme.colors.input, borderRadius: Theme.radius.md, backgroundColor: Theme.colors.card },
  joinContainerFocused: { borderColor: Theme.colors.primary },
  input: { flex: 1, minHeight: 56, color: Theme.colors.foreground, fontSize: 16 },
  clearButton: { width: 36, height: 36, alignItems: "center", justifyContent: "center" },
  joinButton: { width: 46, height: 46, borderRadius: Theme.radius.sm, alignItems: "center", justifyContent: "center", backgroundColor: Theme.colors.secondary },
  joinButtonReady: { backgroundColor: Theme.colors.primary },
  clipboardSection: { marginTop: -Theme.spacing.xs },
  namingCard: { borderWidth: 1, borderColor: Theme.colors.border, borderRadius: Theme.radius.lg, backgroundColor: Theme.colors.card, padding: Theme.spacing.lg, ...Theme.shadows.sm },
  namingHeader: { flexDirection: "row", alignItems: "center", marginBottom: Theme.spacing["2xl"] },
  backButton: { width: 44, height: 44, borderRadius: Theme.radius.sm, borderWidth: 1, borderColor: Theme.colors.border, alignItems: "center", justifyContent: "center", marginRight: Theme.spacing.md },
  namingHeaderCopy: { flex: 1 },
  fieldLabel: { ...Theme.typography.label, color: Theme.colors.foreground, marginBottom: Theme.spacing.sm },
  optionalLabel: { ...Theme.typography.meta, color: Theme.colors.mutedForeground, fontWeight: "400" },
  namingInputContainer: { minHeight: 56, flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: Theme.colors.input, borderRadius: Theme.radius.md, backgroundColor: Theme.colors.background, paddingHorizontal: Theme.spacing.md },
  namingInput: { flex: 1, minHeight: 54, color: Theme.colors.foreground, fontSize: 17 },
  primaryAction: { minHeight: 52, marginTop: Theme.spacing.lg, borderRadius: Theme.radius.sm, backgroundColor: Theme.colors.primary, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: Theme.spacing.sm },
  primaryActionText: { ...Theme.typography.label, color: Theme.colors.primaryForeground, fontSize: 16 },
  emptyState: { alignItems: "center", paddingTop: Theme.spacing["2xl"], paddingBottom: Theme.spacing.lg },
  emptyStateRule: { width: 38, height: 3, borderRadius: 2, backgroundColor: Theme.colors.border, marginBottom: Theme.spacing.md },
  emptyStateTitle: { ...Theme.typography.label, color: Theme.colors.foreground, textAlign: "center" },
  emptyStateDescription: { ...Theme.typography.meta, color: Theme.colors.mutedForeground, textAlign: "center", marginTop: Theme.spacing.xs },
  errorContainer: { borderRadius: Theme.radius.md, borderWidth: 1, borderColor: Theme.colors.error, backgroundColor: Theme.colors.secondary, paddingHorizontal: Theme.spacing.md, paddingVertical: Theme.spacing.md },
  errorText: { ...Theme.typography.label, color: Theme.colors.error, textAlign: "center" },
  buttonPressed: { opacity: 0.76, transform: [{ translateY: 1 }] },
  buttonDisabled: { opacity: 0.45 },
  footer: { paddingHorizontal: Theme.spacing["2xl"], paddingTop: Theme.spacing.sm, paddingBottom: Platform.OS === "ios" ? Theme.spacing.md : Theme.spacing.lg, gap: Theme.spacing.xs },
  footerText: { ...Theme.typography.meta, color: Theme.colors.mutedForeground, textAlign: "center" },
  footerLink: { color: Theme.colors.foreground, fontWeight: "700" },
});
