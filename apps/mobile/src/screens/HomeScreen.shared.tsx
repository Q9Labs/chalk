import { ChalkLogoElements } from "@q9labsai/chalk-react-native";
import { useClipboardInviteSuggestion } from "@q9labsai/chalk-react-native/clipboard";
import { getClipboardInviteSuggestion } from "@q9labsai/chalk-react-native/invites";
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
import { ClipboardInviteSuggestion } from "../components/ClipboardInviteSuggestion";
import { canCreateMeeting, createMeetingLobbyRoute, getApiUrl, parseInputDestination, resolveJoinToken, type LobbyRoute } from "../lib/chalk";

const PUBLIC_SITE_URL = "https://chalkmeet.com";
const PUBLIC_PRIVACY_URL = "https://chalkmeet.com/privacy";

export interface HomeScreenProps {
  onNavigate: (route: LobbyRoute) => void;
  onDiagnosticsFailure?: (source: "resolve-join-link" | "create-meeting", message: string) => void;
}

export function HomeScreenShared({ onNavigate, onDiagnosticsFailure }: HomeScreenProps): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const createEnabled = useMemo(() => canCreateMeeting(), []);
  const [input, setInput] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isCreatingMeeting, setIsCreatingMeeting] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [activeMode, setActiveMode] = useState<"dual" | "naming">("dual");
  const inputRef = useRef<TextInput>(null);
  const namingInputRef = useRef<TextInput>(null);

  const inviteDestination = useMemo(() => parseInputDestination(input), [input]);
  const canOpenInviteLink = Boolean(inviteDestination?.joinToken);
  const clipboardInviteLink = useClipboardInviteSuggestion(input, {
    clipboard: Clipboard,
    getSuggestion: getClipboardInviteSuggestion,
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
    if (!clipboardInviteLink) return;
    setInput(clipboardInviteLink);
    await openInviteLink(clipboardInviteLink);
  };

  const handleNewMeeting = async () => {
    if (!createEnabled) {
      setError(null);
      void Linking.openURL(PUBLIC_SITE_URL);
      return;
    }

    try {
      setError(null);
      setIsCreatingMeeting(true);
      onNavigate(await createMeetingLobbyRoute(apiUrl, newRoomName.trim() || undefined));
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Unable to create meeting";
      setError(message);
      onDiagnosticsFailure?.("create-meeting", message);
    } finally {
      setIsCreatingMeeting(false);
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
              <ChalkLogoElements size={110} />
            </View>
            <Text style={styles.heroTitle}>Video meetings for everyone</Text>
            <Text style={styles.heroSubtitle}>Connect, collaborate, and celebrate from anywhere with Chalk.</Text>
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
                {/* New Meeting Button */}
                <Pressable disabled={isCreatingMeeting} onPress={() => switchMode("naming")} accessibilityRole="button" accessibilityLabel="Create a new meeting" style={({ pressed }) => [styles.newMeetingButton, pressed && styles.buttonPressed, isCreatingMeeting && styles.buttonDisabled]}>
                  <HugeiconsIcon icon={Add01Icon} size={24} color="white" />
                  <Text style={styles.newMeetingButtonText}>{isCreatingMeeting ? "Starting..." : createEnabled ? "New Meeting" : "Create on Web"}</Text>
                </Pressable>

                {!createEnabled ? <Text style={styles.helperText}>Invite links still work in mobile. This build opens the web app for creating a new hosted meeting.</Text> : null}

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
                      placeholder="Paste invite link to join..."
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

                    <Pressable onPress={() => void handleOpenInput()} disabled={!canOpenInviteLink || isResolving} style={({ pressed }) => [styles.goButton, canOpenInviteLink && styles.goButtonReady, pressed && canOpenInviteLink && styles.buttonPressed, isResolving && styles.buttonDisabled]}>
                      {isResolving ? <ActivityIndicator color="white" size="small" /> : <HugeiconsIcon icon={ArrowRight02Icon} size={22} color={canOpenInviteLink ? "white" : Theme.colors.mutedForeground} />}
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
                  <Text style={styles.namingModeTitle}>Name your meeting</Text>
                  <View style={styles.backButtonPlaceholder} />
                </View>

                <View style={[styles.namingInputContainer, styles.joinContainerFocused]}>
                  <TextInput ref={namingInputRef} onChangeText={setNewRoomName} placeholder="Meeting Name (Optional)" placeholderTextColor={Theme.colors.placeholder} style={styles.namingInput} value={newRoomName} onSubmitEditing={() => void handleNewMeeting()} maxLength={40} autoFocus />
                  {newRoomName.length > 0 && (
                    <Pressable onPress={() => setNewRoomName("")} style={({ pressed }) => [styles.clearButton, pressed && styles.buttonPressed]}>
                      <HugeiconsIcon icon={CancelCircleIcon} size={20} color={Theme.colors.mutedForeground} />
                    </Pressable>
                  )}
                </View>

                <Pressable onPress={() => void handleNewMeeting()} disabled={isCreatingMeeting} style={({ pressed }) => [styles.startMeetingButton, pressed && styles.buttonPressed, isCreatingMeeting && styles.buttonDisabled]}>
                  {isCreatingMeeting ? (
                    <ActivityIndicator color="white" size="small" />
                  ) : (
                    <>
                      <Text style={styles.startMeetingButtonText}>Start Meeting</Text>
                      <HugeiconsIcon icon={ArrowRight02Icon} size={20} color="white" />
                    </>
                  )}
                </Pressable>
              </View>
            )}

            {/* Clipboard Suggestion */}
            {clipboardInviteLink && activeMode === "dual" && (
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
  newMeetingButton: {
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
  newMeetingButtonText: {
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
  startMeetingButton: {
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
  startMeetingButtonText: {
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
