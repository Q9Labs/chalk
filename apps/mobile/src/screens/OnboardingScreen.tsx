import ArrowLeft01Icon from "@hugeicons/core-free-icons/dist/esm/ArrowLeft01Icon";
import InformationCircleIcon from "@hugeicons/core-free-icons/dist/esm/InformationCircleIcon";
import Mic01Icon from "@hugeicons/core-free-icons/dist/esm/Mic01Icon";
import Video01Icon from "@hugeicons/core-free-icons/dist/esm/Video01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { saveOnboardingState } from "./onboarding-store";
import { useReducedMotion } from "./onboarding-motion";

const STEP_COUNT = 3;

export interface OnboardingScreenProps {
  onComplete: (displayName: string) => void;
}

function getOnboardingStepLabel(step: number): string {
  return `${Math.min(Math.max(step, 0), STEP_COUNT - 1) + 1} of ${STEP_COUNT}`;
}

export function OnboardingScreen({ onComplete }: OnboardingScreenProps): React.JSX.Element {
  const [step, setStep] = useState(0);
  const [displayName, setDisplayName] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const displayNameInputRef = useRef<TextInput>(null);
  const reducedMotion = useReducedMotion();
  const contentOpacity = useRef(new Animated.Value(0)).current;
  const contentOffset = useRef(new Animated.Value(18)).current;

  const initials = useMemo(() => getInitials(displayName), [displayName]);
  const isNameValid = displayName.trim().length > 0;

  useEffect(() => {
    if (reducedMotion) {
      contentOpacity.setValue(1);
      contentOffset.setValue(0);
      return;
    }

    contentOpacity.setValue(0);
    contentOffset.setValue(18);
    Animated.parallel([
      Animated.timing(contentOpacity, {
        toValue: 1,
        duration: 260,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
      Animated.timing(contentOffset, {
        toValue: 0,
        duration: 320,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
  }, [contentOffset, contentOpacity, reducedMotion, step]);

  const goBack = useCallback(() => {
    if (step === 0 || isSaving) return;
    Keyboard.dismiss();
    setSaveError(null);
    setStep((currentStep) => Math.max(currentStep - 1, 0));
  }, [isSaving, step]);

  const complete = useCallback(
    async (name: string) => {
      if (isSaving) return;
      setSaveError(null);
      setIsSaving(true);
      try {
        await saveOnboardingState(name);
        onComplete(name.trim());
      } catch {
        setSaveError("We couldn’t save your setup yet. Try again.");
      } finally {
        setIsSaving(false);
      }
    },
    [isSaving, onComplete],
  );

  const continueFromStep = useCallback(() => {
    Keyboard.dismiss();
    if (step === 0) {
      setStep(1);
      return;
    }
    if (step === 1) {
      if (isNameValid) setStep(2);
      return;
    }
    void complete(displayName);
  }, [complete, displayName, isNameValid, step]);

  return (
    <SafeAreaView style={styles.container}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.flex}>
        <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={styles.topBar}>
            {step > 0 ? (
              <Pressable accessibilityLabel="Back" accessibilityRole="button" disabled={isSaving} hitSlop={8} onPress={goBack} style={({ pressed }) => [styles.backButton, pressed && styles.pressed, isSaving && styles.disabled]}>
                <HugeiconsIcon color={Theme.colors.foreground} icon={ArrowLeft01Icon} size={24} />
              </Pressable>
            ) : (
              <ChalkWordmark />
            )}
            {step > 0 ? <Text style={styles.stepLabel}>{getOnboardingStepLabel(step)}</Text> : null}
            {step === 0 ? <View style={styles.topBarSpacer} /> : null}
          </View>

          {step > 0 ? (
            <View accessibilityLabel={`Onboarding progress, ${getOnboardingStepLabel(step)}`} accessibilityRole="progressbar" style={styles.progressTrack}>
              {Array.from({ length: STEP_COUNT }, (_, index) => (
                <View key={index} style={[styles.progressSegment, index <= step ? styles.progressSegmentActive : null]} />
              ))}
            </View>
          ) : null}

          <Animated.View style={[styles.content, { opacity: contentOpacity, transform: [{ translateY: contentOffset }] }]}>
            {step === 0 ? <WelcomeStep /> : null}
            {step === 1 ? <IdentityStep displayName={displayName} inputRef={displayNameInputRef} initials={initials} onChangeDisplayName={setDisplayName} /> : null}
            {step === 2 ? <DeviceStep /> : null}
          </Animated.View>
        </ScrollView>

        <View style={styles.bottomArea}>
          {saveError ? (
            <Text accessibilityLiveRegion="assertive" style={styles.errorText}>
              {saveError}
            </Text>
          ) : null}
          <Pressable
            accessibilityLabel={step === 0 ? "Get started" : step === 1 ? "Continue" : "Finish setup"}
            accessibilityRole="button"
            disabled={(step === 1 && !isNameValid) || isSaving}
            onPress={continueFromStep}
            style={({ pressed }) => [styles.primaryButton, pressed && styles.primaryButtonPressed, ((step === 1 && !isNameValid) || isSaving) && styles.disabled]}
          >
            <Text style={styles.primaryButtonText}>{isSaving ? "Saving…" : step === 0 ? "Get started" : step === 1 ? "Continue" : "Finish setup"}</Text>
          </Pressable>
          {step === 2 ? (
            <Pressable accessibilityLabel="Not now" accessibilityRole="button" disabled={isSaving} onPress={() => void complete(displayName)} style={({ pressed }) => [styles.secondaryButton, pressed && styles.secondaryButtonPressed, isSaving && styles.disabled]}>
              <Text style={styles.secondaryButtonText}>Not now</Text>
            </Pressable>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function WelcomeStep(): React.JSX.Element {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.welcomeTitle}>A Space for{`\n`}work in motion.</Text>
      <View style={styles.welcomeGraphic}>
        <View style={[styles.note, styles.noteGreen, styles.noteTopLeft]}>
          <Text style={styles.noteText}>NW</Text>
        </View>
        <View style={[styles.note, styles.notePink, styles.noteTopRight]}>
          <View style={styles.noteLineShort} />
          <View style={styles.noteLine} />
        </View>
        <View style={styles.board}>
          <View style={styles.boardGrid} />
          <View style={[styles.boardTile, styles.boardTilePurple]}>
            <View style={styles.tileLine} />
            <View style={styles.tileLineShort} />
            <View style={styles.tileLine} />
          </View>
          <View style={[styles.boardTile, styles.boardTileBlue]}>
            <View style={styles.imageIcon} />
          </View>
          <View style={[styles.boardTile, styles.boardTileYellow]}>
            <View style={styles.chartIcon} />
          </View>
          <View style={styles.boardAdd}>
            <Text style={styles.boardAddText}>+</Text>
          </View>
        </View>
        <View style={[styles.note, styles.noteYellow, styles.noteBottomLeft]}>
          <View style={styles.noteLineShort} />
          <View style={styles.noteLine} />
        </View>
        <View style={[styles.note, styles.noteBlue, styles.noteBottomRight]}>
          <Text style={styles.noteText}>AJ</Text>
        </View>
      </View>
      <Text style={styles.welcomeSubtitle}>Talk, share, and build{`\n`}together in real time.</Text>
    </View>
  );
}

function IdentityStep({ displayName, initials, inputRef, onChangeDisplayName }: { displayName: string; initials: string; inputRef: React.RefObject<TextInput | null>; onChangeDisplayName: (value: string) => void }): React.JSX.Element {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.stepTitle}>Make it yours</Text>
      <Text style={styles.stepDescription}>Your name helps other Participants{`\n`}recognize you.</Text>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>{initials}</Text>
      </View>
      <Text style={styles.fieldLabel}>Display name</Text>
      <TextInput
        ref={inputRef}
        accessibilityLabel="Display name"
        autoCapitalize="words"
        autoCorrect={false}
        maxLength={64}
        onChangeText={onChangeDisplayName}
        placeholder="Your name"
        placeholderTextColor={Theme.colors.mutedForeground}
        returnKeyType="done"
        style={styles.textInput}
        value={displayName}
      />
      <View style={styles.identityNote}>
        <View style={styles.identityNoteIcon}>
          <Text style={styles.identityNoteIconText}>i</Text>
        </View>
        <Text style={styles.identityNoteText}>You can change this later in Settings.</Text>
      </View>
    </View>
  );
}

function DeviceStep(): React.JSX.Element {
  return (
    <View style={styles.stepContent}>
      <Text style={styles.stepTitle}>Ready when you are</Text>
      <Text style={styles.stepDescription}>Chalk asks only when you choose{`\n`}to speak or be seen.</Text>
      <View style={styles.accessRows}>
        <AccessRow icon={Mic01Icon} label="Microphone" description="Speak and hear Participants" />
        <AccessRow icon={Video01Icon} label="Camera" description="Share video in a Space" />
      </View>
      <View style={styles.controlNote}>
        <HugeiconsIcon color={Theme.colors.chalkBlue} icon={InformationCircleIcon} size={24} />
        <Text style={styles.controlNoteText}>You stay in control from the dock.</Text>
      </View>
    </View>
  );
}

function AccessRow({ description, icon, label }: { description: string; icon: typeof Mic01Icon; label: string }): React.JSX.Element {
  return (
    <View style={styles.accessRow}>
      <View style={styles.accessIcon}>
        <HugeiconsIcon color={Theme.colors.foreground} icon={icon} size={28} />
      </View>
      <View style={styles.accessCopy}>
        <Text style={styles.accessLabel}>{label}</Text>
        <Text style={styles.accessDescription}>{description}</Text>
      </View>
    </View>
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

function getInitials(value: string): string {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: Theme.colors.background },
  flex: { flex: 1 },
  scrollContent: { flexGrow: 1, paddingHorizontal: Theme.spacing["2xl"], paddingTop: Theme.spacing.lg, paddingBottom: Theme.spacing["3xl"] },
  topBar: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  topBarSpacer: { width: 96 },
  wordmark: { flexDirection: "row", alignItems: "center", gap: Theme.spacing.sm },
  wordmarkMark: { width: 32, height: 28, flexDirection: "row", alignItems: "flex-end", gap: 2 },
  wordmarkBar: { width: 6, borderRadius: 3 },
  wordmarkGreen: { height: 20, backgroundColor: Theme.colors.chalkGreen, transform: [{ rotate: "-16deg" }] },
  wordmarkYellow: { height: 24, backgroundColor: Theme.colors.chalkYellow, transform: [{ rotate: "-5deg" }] },
  wordmarkBlue: { height: 28, backgroundColor: Theme.colors.chalkBlue, transform: [{ rotate: "16deg" }] },
  wordmarkPink: { height: 23, backgroundColor: Theme.colors.chalkPink, transform: [{ rotate: "8deg" }] },
  wordmarkText: { color: Theme.colors.foreground, fontSize: 24, fontWeight: "800", letterSpacing: -1 },
  backButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: Theme.radius.sm, borderWidth: 1, borderColor: Theme.colors.border },
  stepLabel: { ...Theme.typography.label, color: Theme.colors.foreground, marginRight: 44 },
  progressTrack: { flexDirection: "row", gap: Theme.spacing.xs, marginTop: Theme.spacing.sm, marginHorizontal: 44 },
  progressSegment: { flex: 1, height: 4, borderRadius: 2, backgroundColor: Theme.colors.border },
  progressSegmentActive: { backgroundColor: Theme.colors.primary },
  content: { flex: 1 },
  stepContent: { paddingTop: Theme.spacing["4xl"], flex: 1 },
  welcomeTitle: { ...Theme.typography.title, color: Theme.colors.foreground, fontSize: 42, lineHeight: 47, letterSpacing: -1.6, marginTop: Theme.spacing["3xl"] },
  welcomeGraphic: { height: 300, marginTop: Theme.spacing["3xl"], alignItems: "center", justifyContent: "center" },
  board: { width: 228, height: 250, borderWidth: 1, borderColor: Theme.colors.border, borderRadius: Theme.radius.lg, backgroundColor: Theme.colors.card, overflow: "hidden", position: "relative" },
  boardGrid: { ...StyleSheet.absoluteFillObject, opacity: 0.55, backgroundColor: Theme.colors.secondary },
  boardTile: { position: "absolute", width: 76, height: 72, borderRadius: Theme.radius.sm, borderWidth: 1, borderColor: Theme.colors.foreground, alignItems: "center", justifyContent: "center" },
  boardTilePurple: { left: 42, top: 34, backgroundColor: Theme.colors.accent },
  boardTileBlue: { right: 32, top: 88, backgroundColor: Theme.colors.washBlue },
  boardTileYellow: { right: 48, bottom: 28, backgroundColor: Theme.colors.washYellow },
  tileLine: { width: 45, height: 2, backgroundColor: Theme.colors.foreground, marginBottom: 8 },
  tileLineShort: { width: 30, height: 2, backgroundColor: Theme.colors.foreground, marginBottom: 8 },
  imageIcon: { width: 36, height: 26, borderWidth: 2, borderColor: Theme.colors.foreground, borderRadius: 4 },
  chartIcon: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: Theme.colors.foreground },
  boardAdd: { position: "absolute", left: 42, bottom: 27, width: 76, height: 72, borderRadius: Theme.radius.sm, borderWidth: 1, borderStyle: "dashed", borderColor: Theme.colors.mutedForeground, alignItems: "center", justifyContent: "center" },
  boardAddText: { color: Theme.colors.foreground, fontSize: 36, fontWeight: "300" },
  note: { position: "absolute", width: 74, height: 48, borderWidth: 1, borderColor: Theme.colors.foreground, borderRadius: Theme.radius.sm, alignItems: "center", justifyContent: "center" },
  noteGreen: { width: 54, height: 54, borderRadius: 27, left: 10, top: 8, backgroundColor: Theme.colors.washGreen },
  notePink: { right: 0, top: 42, backgroundColor: Theme.colors.washPink },
  noteYellow: { left: 0, bottom: 15, backgroundColor: Theme.colors.washYellow },
  noteBlue: { width: 58, height: 58, borderRadius: 29, right: 8, bottom: 0, backgroundColor: Theme.colors.washBlue },
  noteTopLeft: { transform: [{ rotate: "-8deg" }] },
  noteTopRight: { transform: [{ rotate: "3deg" }] },
  noteBottomLeft: { transform: [{ rotate: "-4deg" }] },
  noteBottomRight: { transform: [{ rotate: "8deg" }] },
  noteText: { color: Theme.colors.foreground, fontSize: 16, fontWeight: "700" },
  noteLine: { width: 40, height: 2, backgroundColor: Theme.colors.foreground, marginTop: 6 },
  noteLineShort: { width: 28, height: 2, backgroundColor: Theme.colors.foreground },
  welcomeSubtitle: { ...Theme.typography.body, color: Theme.colors.mutedForeground, fontSize: 21, lineHeight: 30, textAlign: "center", marginTop: Theme.spacing["2xl"] },
  stepTitle: { ...Theme.typography.title, color: Theme.colors.foreground, fontSize: 40, lineHeight: 46, letterSpacing: -1.4 },
  stepDescription: { ...Theme.typography.body, color: Theme.colors.mutedForeground, fontSize: 19, lineHeight: 28, marginTop: Theme.spacing.md },
  avatar: { width: 136, height: 136, borderRadius: 68, backgroundColor: Theme.colors.chalkBlue, alignItems: "center", justifyContent: "center", alignSelf: "center", marginTop: Theme.spacing["4xl"], marginBottom: Theme.spacing["3xl"] },
  avatarText: { color: Theme.colors.primaryForeground, fontSize: 42, fontWeight: "500", letterSpacing: -1 },
  fieldLabel: { ...Theme.typography.label, color: Theme.colors.foreground, fontSize: 16, marginBottom: Theme.spacing.sm },
  textInput: { minHeight: 52, borderWidth: 1, borderColor: Theme.colors.input, borderRadius: Theme.radius.md, backgroundColor: Theme.colors.card, color: Theme.colors.foreground, paddingHorizontal: Theme.spacing.lg, fontSize: 18 },
  identityNote: { flexDirection: "row", alignItems: "center", gap: Theme.spacing.sm, marginTop: Theme.spacing.lg },
  identityNoteIcon: { width: 24, height: 24, borderWidth: 2, borderColor: Theme.colors.mutedForeground, borderRadius: 12, alignItems: "center", justifyContent: "center" },
  identityNoteIconText: { color: Theme.colors.mutedForeground, fontSize: 16, fontWeight: "700" },
  identityNoteText: { ...Theme.typography.body, color: Theme.colors.mutedForeground, flex: 1 },
  accessRows: { gap: Theme.spacing.md, marginTop: Theme.spacing["3xl"] },
  accessRow: { flexDirection: "row", alignItems: "center", minHeight: 108, borderWidth: 1, borderColor: Theme.colors.border, borderRadius: Theme.radius.lg, backgroundColor: Theme.colors.card, padding: Theme.spacing.md },
  accessIcon: { width: 68, height: 68, borderWidth: 1, borderColor: Theme.colors.border, borderRadius: Theme.radius.md, alignItems: "center", justifyContent: "center", backgroundColor: Theme.colors.secondary },
  accessCopy: { flex: 1, marginLeft: Theme.spacing.lg },
  accessLabel: { ...Theme.typography.subheading, color: Theme.colors.foreground },
  accessDescription: { ...Theme.typography.body, color: Theme.colors.mutedForeground, marginTop: 2 },
  controlNote: { flexDirection: "row", alignItems: "center", minHeight: 72, borderWidth: 1, borderColor: Theme.colors.chalkBlue, borderRadius: Theme.radius.lg, backgroundColor: Theme.colors.washBlue, paddingHorizontal: Theme.spacing.lg, marginTop: Theme.spacing.lg, gap: Theme.spacing.md },
  controlNoteText: { ...Theme.typography.body, color: Theme.colors.foreground, flex: 1 },
  bottomArea: { paddingHorizontal: Theme.spacing["2xl"], paddingTop: Theme.spacing.sm, paddingBottom: Platform.OS === "ios" ? Theme.spacing.md : Theme.spacing.lg, backgroundColor: Theme.colors.background },
  primaryButton: { minHeight: 54, borderRadius: Theme.radius.md, backgroundColor: Theme.colors.primary, alignItems: "center", justifyContent: "center", paddingHorizontal: Theme.spacing.lg },
  primaryButtonPressed: { opacity: 0.78, transform: [{ translateY: 1 }] },
  primaryButtonText: { ...Theme.typography.subheading, color: Theme.colors.primaryForeground },
  secondaryButton: { minHeight: 48, alignItems: "center", justifyContent: "center", marginTop: Theme.spacing.xs },
  secondaryButtonPressed: { opacity: 0.62 },
  secondaryButtonText: { ...Theme.typography.label, color: Theme.colors.foreground, fontSize: 16 },
  errorText: { ...Theme.typography.meta, color: Theme.colors.error, textAlign: "center", marginBottom: Theme.spacing.sm },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
});
