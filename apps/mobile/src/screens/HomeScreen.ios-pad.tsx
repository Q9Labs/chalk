import { ChalkLogoElements, Theme } from "@q9labs/chalk-react-native";
import Add01Icon from "@hugeicons/core-free-icons/dist/esm/Add01Icon";
import Link01Icon from "@hugeicons/core-free-icons/dist/esm/Link01Icon";
import ArrowRight02Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight02Icon";
import CancelCircleIcon from "@hugeicons/core-free-icons/dist/esm/CancelCircleIcon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useMemo, useState, useRef, useEffect } from "react";
import { KeyboardAvoidingView, Linking, Pressable, StyleSheet, Text, TextInput, View, Animated, ActivityIndicator } from "react-native";
import { StatusBar } from "expo-status-bar";
import { SafeAreaView } from "react-native-safe-area-context";
import { canCreateMeeting, createMeetingLobbyRoute, getApiUrl, parseInputDestination, resolveJoinToken, type LobbyRoute } from "../lib/chalk";
import { useClipboardInviteSuggestion } from "./useClipboardInviteSuggestion";
import { ClipboardInviteSuggestion } from "../components/ClipboardInviteSuggestion";

const PUBLIC_SITE_URL = "https://chalkmeet.com";

export interface HomeScreenProps {
  onNavigate: (route: LobbyRoute) => void;
  onDiagnosticsFailure?: (source: "resolve-join-link" | "create-meeting", message: string) => void;
}

export function HomeScreenIosPad({ onNavigate, onDiagnosticsFailure }: HomeScreenProps): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const createEnabled = useMemo(() => canCreateMeeting(), []);
  const [input, setInput] = useState("");
  const [newRoomName, setNewRoomName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isCreatingMeeting, setIsCreatingMeeting] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [showNamingDialog, setShowNamingDialog] = useState(false);
  const inputRef = useRef<TextInput>(null);
  const namingInputRef = useRef<TextInput>(null);

  const namingDialogAnim = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(namingDialogAnim, {
      toValue: showNamingDialog ? 1 : 0,
      tension: 30,
      friction: 8,
      useNativeDriver: true,
    }).start();

    if (showNamingDialog) {
      setTimeout(() => namingInputRef.current?.focus(), 100);
    }
  }, [showNamingDialog, namingDialogAnim]);

  const inviteDestination = useMemo(() => parseInputDestination(input), [input]);
  const canOpenInviteLink = Boolean(inviteDestination?.joinToken);
  const clipboardInviteLink = useClipboardInviteSuggestion(input);

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
      setShowNamingDialog(false);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Unable to create meeting";
      setError(message);
      onDiagnosticsFailure?.("create-meeting", message);
    } finally {
      setIsCreatingMeeting(false);
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
              <ChalkLogoElements size={120} />
            </View>
            <Text style={styles.heroTitle}>Video meetings for everyone</Text>
            <Text style={styles.heroSubtitle}>
              Connect, collaborate, and celebrate from anywhere with Chalk.
            </Text>
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
              <Pressable
                disabled={isCreatingMeeting}
                onPress={() => setShowNamingDialog(true)}
                accessibilityRole="button"
                accessibilityLabel="Create a new meeting"
                style={({ pressed }) => [
                  styles.newMeetingAction,
                  pressed && styles.buttonPressed,
                ]}
              >
                <HugeiconsIcon icon={Add01Icon} size={24} color={Theme.colors.primary} />
                <Text style={styles.actionLabel}>New Meeting</Text>
              </Pressable>

              <View style={styles.divider} />

              <View style={[styles.joinContainer, isInputFocused && styles.joinContainerFocused]}>
                <HugeiconsIcon
                  icon={Link01Icon}
                  size={24}
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
                      size={24} 
                      color={canOpenInviteLink ? "white" : Theme.colors.mutedForeground} 
                    />
                  )}
                </Pressable>
              </View>
            </View>

            {clipboardInviteLink && (
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

      {/* Naming Dialog Overlay */}
      {showNamingDialog && (
        <Animated.View 
          style={[
            StyleSheet.absoluteFill, 
            styles.dialogOverlay,
            { opacity: namingDialogAnim }
          ]}
        >
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setShowNamingDialog(false)} />
          <Animated.View 
            style={[
              styles.namingDialog,
              {
                transform: [
                  { scale: namingDialogAnim.interpolate({ inputRange: [0, 1], outputRange: [0.9, 1] }) },
                  { translateY: namingDialogAnim.interpolate({ inputRange: [0, 1], outputRange: [20, 0] }) }
                ]
              }
            ]}
          >
            <View style={styles.dialogHeader}>
              <Text style={styles.dialogTitle}>Name your meeting</Text>
              <Text style={styles.dialogSubtitle}>Give your space a unique name or leave it blank for a surprise.</Text>
            </View>

            <View style={styles.namingInputContainer}>
              <TextInput
                ref={namingInputRef}
                onChangeText={setNewRoomName}
                placeholder="Meeting Name (Optional)"
                placeholderTextColor="rgba(255,255,255,0.3)"
                style={styles.namingInput}
                value={newRoomName}
                onSubmitEditing={() => void handleNewMeeting()}
                maxLength={40}
              />
              <Pressable
                onPress={() => void handleNewMeeting()}
                disabled={isCreatingMeeting}
                style={({ pressed }) => [
                  styles.namingGoButton,
                  pressed && styles.buttonPressed,
                  isCreatingMeeting && styles.buttonDisabled,
                ]}
              >
                {isCreatingMeeting ? (
                  <ActivityIndicator color="white" size="small" />
                ) : (
                  <HugeiconsIcon icon={ArrowRight02Icon} size={24} color="white" />
                )}
              </Pressable>
            </View>

            <Pressable 
              onPress={() => setShowNamingDialog(false)} 
              style={({ pressed }) => [styles.cancelNaming, pressed && styles.buttonPressed]}
            >
              <Text style={styles.cancelNamingText}>Cancel</Text>
            </Pressable>
          </Animated.View>
        </Animated.View>
      )}
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
  newMeetingAction: {
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
  dialogOverlay: {
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 100,
  },
  namingDialog: {
    width: 480,
    backgroundColor: "rgba(20,20,22,0.95)",
    borderRadius: 32,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.12)",
    padding: 32,
    gap: 24,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 20 },
    shadowOpacity: 0.4,
    shadowRadius: 30,
    elevation: 30,
  },
  dialogHeader: {
    alignItems: "center",
    gap: 8,
  },
  dialogTitle: {
    color: "white",
    fontSize: 24,
    fontWeight: "800",
  },
  dialogSubtitle: {
    color: Theme.colors.mutedForeground,
    fontSize: 15,
    textAlign: "center",
    lineHeight: 22,
  },
  namingInputContainer: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "rgba(255,255,255,0.05)",
    borderRadius: 20,
    padding: 8,
    height: 72,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
  },
  namingInput: {
    flex: 1,
    color: "white",
    fontSize: 18,
    fontWeight: "700",
    paddingHorizontal: 16,
  },
  namingGoButton: {
    width: 56,
    height: 56,
    borderRadius: 16,
    backgroundColor: Theme.colors.primary,
    alignItems: "center",
    justifyContent: "center",
  },
  cancelNaming: {
    alignSelf: "center",
    padding: 8,
  },
  cancelNamingText: {
    color: Theme.colors.mutedForeground,
    fontSize: 15,
    fontWeight: "600",
  },
});

