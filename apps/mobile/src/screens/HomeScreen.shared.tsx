import ArrowRight02Icon from "@hugeicons/core-free-icons/dist/esm/ArrowRight02Icon";
import CancelCircleIcon from "@hugeicons/core-free-icons/dist/esm/CancelCircleIcon";
import Link01Icon from "@hugeicons/core-free-icons/dist/esm/Link01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { useClipboardInviteSuggestion } from "@q9labsai/chalk-react-native/clipboard";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Animated, Easing, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { BrandMark } from "../components/BrandMark";
import { ClipboardInviteSuggestion } from "../components/ClipboardInviteSuggestion";
import { enterLocalSpaceRoute, getClipboardSpaceSuggestion, parseSpaceLink, resolveSpaceInvite, type SpaceRoute } from "../lib/spaces";
import { useReducedMotion } from "./onboarding-motion";
import { CreateSpaceSheet } from "./CreateSpaceSheet";
import { CreateSpaceIllustration, SpaceHistoryIllustration } from "./HomeIllustrations";

const PUBLIC_SITE_URL = "https://chalkmeet.com";
const PUBLIC_PRIVACY_URL = "https://chalkmeet.com/privacy";

export interface HomeScreenProps {
  onNavigate: (route: SpaceRoute) => void;
  onDiagnosticsFailure?: (source: "resolve-space-link" | "enter-space", message: string) => void;
}

export function HomeScreenShared({ onNavigate, onDiagnosticsFailure }: HomeScreenProps): React.JSX.Element {
  const createEnabled = false;
  const [input, setInput] = useState("");
  const [newSpaceName, setNewSpaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [isOpeningLocalSpace, setIsOpeningLocalSpace] = useState(false);
  const [isInputFocused, setIsInputFocused] = useState(false);
  const [createSheetOpen, setCreateSheetOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const entrance = useRef(new Animated.Value(0)).current;

  const spaceDestination = useMemo(() => parseSpaceLink(input), [input]);
  const canOpenSpaceLink = Boolean(spaceDestination?.spaceInviteToken);
  const clipboardSpaceLink = useClipboardInviteSuggestion(input, { clipboard: Clipboard, getSuggestion: getClipboardSpaceSuggestion });

  useEffect(() => {
    if (reducedMotion) {
      entrance.setValue(1);
      return;
    }
    const animation = Animated.timing(entrance, { duration: 420, easing: Easing.out(Easing.cubic), toValue: 1, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [entrance, reducedMotion]);

  const openSpaceLink = useCallback(
    async (spaceLink: string) => {
      const spaceInviteToken = parseSpaceLink(spaceLink)?.spaceInviteToken;
      if (!spaceInviteToken) {
        setError("Paste a valid Space link to join this Space.");
        return;
      }
      setError(null);
      try {
        setIsResolving(true);
        onNavigate(await resolveSpaceInvite(spaceInviteToken));
      } catch (nextError) {
        const message = nextError instanceof Error ? nextError.message : "This Space link could not be opened.";
        setError(message);
        onDiagnosticsFailure?.("resolve-space-link", message);
      } finally {
        setIsResolving(false);
      }
    },
    [onDiagnosticsFailure, onNavigate],
  );

  const handleClipboardSuggestion = useCallback(async () => {
    if (!clipboardSpaceLink) return;
    setInput(clipboardSpaceLink);
    await openSpaceLink(clipboardSpaceLink);
  }, [clipboardSpaceLink, openSpaceLink]);

  const handleEnterSpace = useCallback(async () => {
    try {
      setError(null);
      setIsOpeningLocalSpace(true);
      onNavigate(await enterLocalSpaceRoute(newSpaceName.trim() || undefined));
      setCreateSheetOpen(false);
    } catch (nextError) {
      const message = nextError instanceof Error ? nextError.message : "Unable to open this Space.";
      setError(message);
      onDiagnosticsFailure?.("enter-space", message);
    } finally {
      setIsOpeningLocalSpace(false);
    }
  }, [newSpaceName, onDiagnosticsFailure, onNavigate]);

  const animatedStyle = {
    opacity: entrance,
    transform: [{ translateY: entrance.interpolate({ inputRange: [0, 1], outputRange: [14, 0] }) }],
  };

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <ScrollView bounces contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <Animated.View style={[styles.header, animatedStyle]}>
            <View accessibilityLabel="Chalk" style={styles.wordmark}>
              <BrandMark size={34} />
              <Text style={styles.wordmarkText}>chalk</Text>
            </View>
          </Animated.View>

          <Animated.View style={[styles.hero, animatedStyle]}>
            <Text style={styles.heroTitle}>A Space for work{`\n`}in motion.</Text>
            <Text style={styles.heroSubtitle}>Start something new or open an invite. Your shared work stays close.</Text>
          </Animated.View>

          <Animated.View style={[styles.content, animatedStyle]}>
            <Pressable accessibilityLabel="Open local Space" accessibilityRole="button" onPress={() => setCreateSheetOpen(true)} style={({ pressed }) => [styles.createRow, pressed && styles.rowPressed]}>
              <View style={styles.createCopy}>
                <Text style={styles.sectionTitle}>Open local Space</Text>
                <Text style={styles.sectionDescription}>Try the shared local Space on this device.</Text>
                <View style={styles.textAction}>
                  <Text style={styles.textActionLabel}>{createEnabled ? "Create" : "Open"}</Text>
                  <HugeiconsIcon color={Theme.colors.ink} icon={ArrowRight02Icon} size={18} />
                </View>
              </View>
              <CreateSpaceIllustration />
            </Pressable>

            <View style={styles.joinSection}>
              <View style={styles.sectionHeading}>
                <Text style={styles.sectionTitle}>Join a Space</Text>
                <Text style={styles.sectionMeta}>Have an invite?</Text>
              </View>
              <View style={[styles.joinContainer, isInputFocused && styles.joinContainerFocused]}>
                <HugeiconsIcon color={isInputFocused ? Theme.colors.ink : Theme.colors.ink3} icon={Link01Icon} size={20} />
                <TextInput
                  accessibilityLabel="Space link"
                  autoCapitalize="none"
                  autoCorrect={false}
                  onBlur={() => setIsInputFocused(false)}
                  onChangeText={(text) => {
                    setInput(text);
                    setError(null);
                  }}
                  onFocus={() => setIsInputFocused(true)}
                  onSubmitEditing={() => void openSpaceLink(input)}
                  placeholder="Paste Space link"
                  placeholderTextColor={Theme.colors.placeholder}
                  style={styles.input}
                  value={input}
                />
                {input ? (
                  <Pressable accessibilityLabel="Clear Space link" hitSlop={8} onPress={() => setInput("")}>
                    <HugeiconsIcon color={Theme.colors.ink3} icon={CancelCircleIcon} size={19} />
                  </Pressable>
                ) : null}
                <Pressable accessibilityLabel="Join Space" accessibilityRole="button" disabled={!canOpenSpaceLink || isResolving} onPress={() => void openSpaceLink(input)} style={({ pressed }) => [styles.joinButton, canOpenSpaceLink && styles.joinButtonReady, pressed && styles.rowPressed]}>
                  {isResolving ? <ActivityIndicator color={Theme.colors.primaryForeground} size="small" /> : <HugeiconsIcon color={canOpenSpaceLink ? Theme.colors.primaryForeground : Theme.colors.ink3} icon={ArrowRight02Icon} size={20} />}
                </Pressable>
              </View>
            </View>

            {clipboardSpaceLink ? <ClipboardInviteSuggestion isLoading={isResolving} onPress={() => void handleClipboardSuggestion()} /> : null}
            {error ? (
              <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
                {error}
              </Text>
            ) : null}

            <View style={styles.historySection}>
              <SpaceHistoryIllustration />
              <Text style={styles.emptyTitle}>Your Spaces will gather here.</Text>
              <Text style={styles.emptyDescription}>Open an invite or the local Space to begin your history.</Text>
            </View>
          </Animated.View>
        </ScrollView>

        <View style={styles.footer}>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(PUBLIC_SITE_URL)}>
            <Text style={styles.footerText}>
              Learn more at <Text style={styles.footerLink}>chalkmeet.com</Text>
            </Text>
          </Pressable>
          <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(PUBLIC_PRIVACY_URL)}>
            <Text style={styles.footerLink}>Privacy Policy</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
      <CreateSpaceSheet createEnabled={createEnabled} isCreating={isOpeningLocalSpace} isOpen={createSheetOpen} name={newSpaceName} onChangeName={setNewSpaceName} onClose={() => setCreateSheetOpen(false)} onCreate={() => void handleEnterSpace()} />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { backgroundColor: Theme.colors.background, flex: 1 },
  flex: { flex: 1 },
  scrollContent: { paddingBottom: Theme.spacing["4xl"], paddingHorizontal: Theme.spacing["2xl"], paddingTop: Theme.spacing.md },
  header: { alignItems: "center", flexDirection: "row", minHeight: 44 },
  wordmark: { alignItems: "center", flexDirection: "row", gap: 7 },
  wordmarkText: { color: Theme.colors.ink, fontSize: 22, fontWeight: "800", letterSpacing: -0.8 },
  hero: { marginBottom: Theme.spacing["3xl"], marginTop: Theme.spacing["3xl"] },
  heroTitle: { color: Theme.colors.ink, fontSize: 34, fontWeight: "800", letterSpacing: -1.1, lineHeight: 39 },
  heroSubtitle: { color: Theme.colors.ink2, fontSize: 15, lineHeight: 22, marginTop: Theme.spacing.md, maxWidth: 330 },
  content: { gap: Theme.spacing["3xl"] },
  createRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", marginHorizontal: -4, minHeight: 122 },
  createCopy: { flex: 1, paddingRight: Theme.spacing.sm },
  sectionTitle: { color: Theme.colors.ink, fontSize: 19, fontWeight: "700", letterSpacing: -0.25 },
  sectionDescription: { color: Theme.colors.ink2, fontSize: 14, lineHeight: 20, marginTop: 5 },
  textAction: { alignItems: "center", flexDirection: "row", gap: 5, marginTop: 11 },
  textActionLabel: { color: Theme.colors.ink, fontSize: 14, fontWeight: "700" },
  joinSection: { gap: Theme.spacing.sm },
  sectionHeading: { alignItems: "baseline", flexDirection: "row", justifyContent: "space-between" },
  sectionMeta: { color: Theme.colors.ink3, fontSize: 13 },
  joinContainer: { alignItems: "center", backgroundColor: Theme.colors.surface, borderColor: Theme.colors.lineStrong, borderRadius: Theme.radius.md, borderWidth: 1, flexDirection: "row", gap: Theme.spacing.sm, minHeight: 58, paddingLeft: Theme.spacing.lg, paddingRight: 5 },
  joinContainerFocused: { borderColor: Theme.colors.chalkBlue, borderWidth: 2, paddingLeft: Theme.spacing.lg - 1, paddingRight: 4 },
  input: { color: Theme.colors.ink, flex: 1, fontSize: 15, minHeight: 54, paddingVertical: 0 },
  joinButton: { alignItems: "center", backgroundColor: Theme.colors.paper2, borderRadius: Theme.radius.sm, height: 46, justifyContent: "center", width: 46 },
  joinButtonReady: { backgroundColor: Theme.colors.ink },
  historySection: { alignItems: "center", borderTopColor: Theme.colors.line, borderTopWidth: 1, paddingTop: Theme.spacing["2xl"] },
  emptyTitle: { color: Theme.colors.ink, fontSize: 16, fontWeight: "700", marginTop: Theme.spacing.sm },
  emptyDescription: { color: Theme.colors.ink2, fontSize: 13, lineHeight: 19, marginTop: 5, maxWidth: 270, textAlign: "center" },
  errorText: { color: Theme.colors.error, fontSize: 13, textAlign: "center" },
  footer: { alignItems: "center", borderTopColor: Theme.colors.line, borderTopWidth: 1, flexDirection: "row", justifyContent: "space-between", marginHorizontal: Theme.spacing["2xl"], minHeight: 52 },
  footerText: { color: Theme.colors.ink3, fontSize: 12 },
  footerLink: { color: Theme.colors.ink2, fontSize: 12, fontWeight: "600" },
  rowPressed: { opacity: 0.76, transform: [{ scale: 0.99 }] },
});
