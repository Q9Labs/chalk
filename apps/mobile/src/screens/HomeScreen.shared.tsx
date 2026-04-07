import { ChalkLogoElements, Theme } from "@q9labs/chalk-react-native";
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
import { useClipboardInviteSuggestion } from "./useClipboardInviteSuggestion";

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
  const clipboardInviteLink = useClipboardInviteSuggestion(input);

  const entryHeroAnim = useRef(new Animated.Value(0)).current;
  const entryActionsAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.stagger(180, [
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
                      outputRange: [20, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <View style={styles.illustrationFrame}>
              <View style={styles.glow} />
              <ChalkLogoElements size={100} />
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
                      outputRange: [30, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            {activeMode === "dual" ? (
              <>
                {/* New Meeting Button */}
                <Pressable
                  disabled={isCreatingMeeting}
                  onPress={() => switchMode("naming")}
                  accessibilityRole="button"
                  accessibilityLabel="Create a new meeting"
                  style={({ pressed }) => [
                    styles.newMeetingButton,
                    pressed && styles.buttonPressed,
                    isCreatingMeeting && styles.buttonDisabled,
                  ]}
                >
                  <HugeiconsIcon icon={Add01Icon} size={22} color="white" />
                  <Text style={styles.newMeetingButtonText}>
                    {isCreatingMeeting ? "Starting..." : createEnabled ? "New Meeting" : "Create on Web"}
                  </Text>
                </Pressable>

                {!createEnabled ? (
                  <Text style={styles.helperText}>Invite links still work in mobile. This build opens the web app for creating a new hosted meeting.</Text>
                ) : null}

                {/* Join Input Section */}
                <View style={styles.joinSection}>
                  <View style={[styles.joinContainer, isInputFocused && styles.joinContainerFocused]}>
                    <HugeiconsIcon
                      icon={Link01Icon}
                      size={22}
                      color={isInputFocused ? Theme.colors.primary : Theme.colors.mutedForeground}
                      style={styles.inputIcon}
                    />
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
                      <Pressable
                        onPress={() => setInput("")}
                        style={({ pressed }) => [styles.clearButton, pressed && styles.buttonPressed]}
                      >
                        <HugeiconsIcon icon={CancelCircleIcon} size={20} color={Theme.colors.mutedForeground} />
                      </Pressable>
                    )}

                    <Pressable
                      onPress={() => void handleOpenInput()}
                      disabled={!canOpenInviteLink || isResolving}
                      style={({ pressed }) => [
                        styles.goButton,
                        canOpenInviteLink && styles.goButtonReady,
                        pressed && canOpenInviteLink && styles.buttonPressed,
                        isResolving && styles.buttonDisabled,
                      ]}
                    >
                      {isResolving ? (
                        <ActivityIndicator color="white" size="small" />
                      ) : (
                        <HugeiconsIcon
                          icon={ArrowRight02Icon}
                          size={22}
                          color={canOpenInviteLink ? "white" : Theme.colors.mutedForeground}
                        />
                      )}
                    </Pressable>
                  </View>
                </View>
              </>
            ) : (
              /* Naming Mode */
              <View style={styles.namingModeContainer}>
                <View style={styles.namingModeHeader}>
                  <Pressable
                    onPress={() => switchMode("dual")}
                    style={({ pressed }) => [styles.backButton, pressed && styles.buttonPressed]}
                  >
                    <HugeiconsIcon icon={ArrowLeft01Icon} size={22} color={Theme.colors.mutedForeground} />
                  </Pressable>
                  <Text style={styles.namingModeTitle}>Name your meeting</Text>
                  <View style={styles.backButtonPlaceholder} />
                </View>

                <View style={styles.namingInputContainer}>
                  <TextInput
                    ref={namingInputRef}
                    onChangeText={setNewRoomName}
                    placeholder="Meeting Name (Optional)"
                    placeholderTextColor={Theme.colors.placeholder}
                    style={styles.namingInput}
                    value={newRoomName}
                    onSubmitEditing={() => void handleNewMeeting()}
                    maxLength={40}
                    autoFocus
                  />
                  {newRoomName.length > 0 && (
                    <Pressable
                      onPress={() => setNewRoomName("")}
                      style={({ pressed }) => [styles.clearButton, pressed && styles.buttonPressed]}
                    >
                      <HugeiconsIcon icon={CancelCircleIcon} size={20} color={Theme.colors.mutedForeground} />
                    </Pressable>
                  )}
                </View>

                <Pressable
                  onPress={() => void handleNewMeeting()}
                  disabled={isCreatingMeeting}
                  style={({ pressed }) => [
                    styles.startMeetingButton,
                    pressed && styles.buttonPressed,
                    isCreatingMeeting && styles.buttonDisabled,
                  ]}
                >
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
    fontSize: 28,
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
    paddingHorizontal: 16,
  },
  actionsContainer: {
    gap: 16,
  },
  newMeetingButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.primary,
    height: 56,
    borderRadius: 18,
    gap: 10,
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 5,
  },
  newMeetingButtonText: {
    color: "white",
    fontSize: 17,
    fontWeight: "700",
  },
  buttonPressed: {
    transform: [{ scale: 0.97 }],
    opacity: 0.9,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  helperText: {
    color: Theme.colors.mutedForeground,
    fontSize: 13,
    lineHeight: 19,
    textAlign: "center",
    paddingHorizontal: 10,
  },
  joinSection: {
    marginTop: 8,
  },
  joinContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    height: 58,
    paddingHorizontal: 16,
  },
  joinContainerFocused: {
    borderColor: Theme.colors.primary,
    backgroundColor: "rgba(27, 182, 166, 0.04)",
  },
  inputIcon: {
    marginRight: 10,
  },
  input: {
    flex: 1,
    color: Theme.colors.foreground,
    fontSize: 16,
    fontWeight: "600",
  },
  clearButton: {
    padding: 6,
    marginRight: 4,
  },
  goButton: {
    width: 44,
    height: 44,
    borderRadius: 14,
    backgroundColor: "rgba(255, 255, 255, 0.05)",
    alignItems: "center",
    justifyContent: "center",
  },
  goButtonReady: {
    backgroundColor: Theme.colors.primary,
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 3,
  },
  clipboardSection: {
    marginTop: 8,
  },
  errorContainer: {
    borderRadius: 16,
    backgroundColor: "rgba(239, 68, 68, 0.1)",
    borderWidth: 1,
    borderColor: "rgba(239, 68, 68, 0.2)",
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  errorText: {
    color: Theme.colors.error,
    fontSize: 14,
    fontWeight: "600",
    textAlign: "center",
  },
  namingModeContainer: {
    gap: 16,
  },
  namingModeHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 8,
  },
  backButton: {
    padding: 8,
    marginLeft: -8,
  },
  backButtonPlaceholder: {
    width: 38,
  },
  namingModeTitle: {
    fontSize: 17,
    fontWeight: "700",
    color: Theme.colors.foreground,
  },
  namingInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255, 255, 255, 0.04)",
    borderRadius: 18,
    borderWidth: 1,
    borderColor: "rgba(255, 255, 255, 0.08)",
    height: 58,
    paddingHorizontal: 16,
  },
  namingInput: {
    flex: 1,
    color: Theme.colors.foreground,
    fontSize: 17,
    fontWeight: "600",
  },
  startMeetingButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.primary,
    height: 56,
    borderRadius: 18,
    gap: 8,
    shadowColor: Theme.colors.primary,
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.25,
    shadowRadius: 12,
    elevation: 5,
    marginTop: 8,
  },
  startMeetingButtonText: {
    color: "white",
    fontSize: 17,
    fontWeight: "700",
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
