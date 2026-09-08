import type { FeedbackCategory, FeedbackEvidenceInput, FeedbackPrepared, FeedbackScreenshotCapture, FeedbackScreenshotUnavailable, SpaceClient } from "@q9labsai/chalk-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Image, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { useNativeTheme } from "../../ui/native-theme";
import { Theme } from "../../ui/theme";
import { createNativeFeedbackEvidence } from "../../feedback/native-evidence";
import { captureNativeFeedbackView, type FeedbackCaptureSize, type FeedbackCaptureTarget } from "../../feedback/native-capture";

type FeedbackScreenshot = FeedbackScreenshotCapture | FeedbackScreenshotUnavailable;

export interface FeedbackSheetProps {
  readonly client: SpaceClient;
  readonly requested: boolean;
  readonly captureTarget: FeedbackCaptureTarget;
  readonly captureSize: FeedbackCaptureSize;
  readonly feedbackEvidence?: Partial<FeedbackEvidenceInput>;
  readonly onClose: () => void;
}

const categories: readonly FeedbackCategory[] = ["bug", "feature_request", "other"];

export function FeedbackSheet({ client, requested, captureTarget, captureSize, feedbackEvidence, onClose }: FeedbackSheetProps): React.JSX.Element {
  const theme = useNativeTheme();
  const [visible, setVisible] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const [sending, setSending] = useState(false);
  const [category, setCategory] = useState<FeedbackCategory>("bug");
  const [message, setMessage] = useState("");
  const [screenshot, setScreenshot] = useState<FeedbackScreenshot>({ state: "unavailable", failure_code: "capture_failed" });
  const [prepared, setPrepared] = useState<FeedbackPrepared | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [receiptId, setReceiptId] = useState<string | undefined>();
  const evidence = useMemo(() => ({ ...createNativeFeedbackEvidence(), ...feedbackEvidence }), [feedbackEvidence]);
  const prepareScreenshot = useCallback((nextScreenshot: FeedbackScreenshot) => client.feedback.prepare({ evidence, screenshot_provider: () => nextScreenshot }), [client.feedback, evidence]);

  useEffect(() => {
    if (!requested) {
      setVisible(false);
      return;
    }

    let active = true;
    setPreparing(true);
    setSending(false);
    setCategory("bug");
    setMessage("");
    setError(undefined);
    setReceiptId(undefined);
    setPrepared(undefined);

    const prepare = async (): Promise<void> => {
      let captured: FeedbackScreenshot;
      try {
        captured = await captureNativeFeedbackView(captureTarget, captureSize);
      } catch {
        captured = { state: "unavailable", failure_code: "capture_failed" };
      }
      if (!active) return;
      setScreenshot(captured);
      try {
        const nextPrepared = await prepareScreenshot(captured);
        if (!active) return;
        setPrepared(nextPrepared);
      } catch (cause) {
        if (!active) return;
        setError(errorMessage(cause));
      } finally {
        if (active) {
          setPreparing(false);
          setVisible(true);
        }
      }
    };

    void prepare();
    return () => {
      active = false;
    };
  }, [captureSize, captureTarget, prepareScreenshot, requested]);

  const close = useCallback(() => {
    setVisible(false);
    onClose();
  }, [onClose]);

  const refresh = useCallback(async () => {
    if (preparing || sending) return;
    setPreparing(true);
    setPrepared(undefined);
    setError(undefined);
    let captured: FeedbackScreenshot;
    try {
      captured = await captureNativeFeedbackView(captureTarget, captureSize);
    } catch {
      captured = { state: "unavailable", failure_code: "capture_failed" };
    }
    setScreenshot(captured);
    try {
      setPrepared(await prepareScreenshot(captured));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPreparing(false);
    }
  }, [captureSize, captureTarget, prepareScreenshot, preparing, sending]);

  const removeScreenshot = useCallback(async () => {
    if (preparing || sending) return;
    const removed: FeedbackScreenshot = { state: "removed" };
    setPreparing(true);
    setPrepared(undefined);
    setScreenshot(removed);
    setError(undefined);
    try {
      setPrepared(await prepareScreenshot(removed));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPreparing(false);
    }
  }, [prepareScreenshot, preparing, sending]);

  const submit = useCallback(async () => {
    if (sending || !message.trim()) return;
    setSending(true);
    setError(undefined);
    try {
      const request = prepared ?? (await prepareScreenshot(screenshot));
      setPrepared(request);
      const receipt = await request.send({ category, message });
      setReceiptId(receipt.id);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSending(false);
    }
  }, [category, message, prepareScreenshot, prepared, screenshot, sending]);

  const selectCategory = useCallback((nextCategory: FeedbackCategory) => {
    setCategory(nextCategory);
    setPrepared(undefined);
  }, []);

  const updateMessage = useCallback((nextMessage: string) => {
    setMessage(nextMessage);
    setPrepared(undefined);
  }, []);

  const screenshotUri = screenshotDataUri(screenshot);
  const canSubmit = message.trim().length > 0 && !sending && !preparing && !receiptId;

  return (
    <Modal animationType="slide" onRequestClose={close} transparent visible={visible}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={styles.overlay}>
        <Pressable accessibilityLabel="Close Feedback" onPress={close} style={styles.backdrop} />
        <View style={[styles.sheet, { backgroundColor: theme.colors.background }]}>
          <View style={styles.header}>
            <View style={styles.headerCopy}>
              <Text accessibilityRole="header" style={[styles.title, { color: theme.colors.foreground }]}>
                Feedback
              </Text>
              <Text style={[styles.subtitle, { color: theme.colors.mutedForeground }]}>Tell Chalk what happened. We receive this report with safe diagnostic context.</Text>
            </View>
            <Pressable accessibilityLabel="Close Feedback" accessibilityRole="button" disabled={sending} onPress={close} style={styles.closeButton}>
              <Text style={[styles.closeText, { color: theme.colors.foreground }]}>×</Text>
            </Pressable>
          </View>

          {receiptId ? (
            <View style={styles.success}>
              <Text style={[styles.successTitle, { color: theme.colors.foreground }]}>Feedback sent to Chalk</Text>
              <Text style={[styles.subtitle, { color: theme.colors.mutedForeground }]}>Thanks. Chalk received your report.</Text>
              <Pressable accessibilityRole="button" onPress={close} style={[styles.primaryButton, { backgroundColor: theme.colors.primary }]}>
                <Text style={[styles.primaryButtonText, { color: theme.colors.primaryForeground }]}>Done</Text>
              </Pressable>
            </View>
          ) : (
            <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
              <Text style={[styles.label, { color: theme.colors.foreground }]}>Category</Text>
              <View style={styles.categoryRow}>
                {categories.map((option) => (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ selected: category === option }}
                    key={option}
                    onPress={() => selectCategory(option)}
                    style={[styles.categoryButton, { borderColor: theme.colors.border }, category === option && { backgroundColor: theme.colors.primary, borderColor: theme.colors.primary }]}
                  >
                    <Text style={[styles.categoryText, { color: category === option ? theme.colors.primaryForeground : theme.colors.foreground }]}>{categoryLabel(option)}</Text>
                  </Pressable>
                ))}
              </View>

              <Text style={[styles.label, { color: theme.colors.foreground }]}>Message</Text>
              <TextInput
                accessibilityLabel="Feedback message"
                editable={!sending}
                maxLength={8_000}
                multiline
                onChangeText={updateMessage}
                placeholder={category === "bug" ? "What went wrong?" : category === "feature_request" ? "What would help?" : "What should Chalk know?"}
                placeholderTextColor={theme.colors.placeholder}
                style={[styles.messageInput, { borderColor: theme.colors.border, color: theme.colors.foreground }]}
                textAlignVertical="top"
                value={message}
              />

              <Text style={[styles.label, { color: theme.colors.foreground }]}>Screenshot</Text>
              {screenshotUri ? (
                <View style={styles.thumbnailFrame}>
                  <Image accessibilityLabel="Feedback screenshot preview" source={{ uri: screenshotUri }} style={styles.thumbnail} />
                  <View style={styles.thumbnailActions}>
                    <Pressable accessibilityRole="button" disabled={preparing || sending} onPress={() => void refresh()} style={styles.smallButton}>
                      <Text style={[styles.smallButtonText, { color: theme.colors.primary }]}>Refresh</Text>
                    </Pressable>
                    <Pressable accessibilityRole="button" disabled={preparing || sending} onPress={() => void removeScreenshot()} style={styles.smallButton}>
                      <Text style={[styles.smallButtonText, { color: theme.colors.error }]}>Remove</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={[styles.unavailable, { borderColor: theme.colors.border }]}>
                  <Text style={[styles.unavailableText, { color: theme.colors.mutedForeground }]}>Screenshot unavailable. You can still send Feedback.</Text>
                  <Pressable accessibilityRole="button" disabled={preparing || sending} onPress={() => void refresh()} style={styles.smallButton}>
                    <Text style={[styles.smallButtonText, { color: theme.colors.primary }]}>Refresh</Text>
                  </Pressable>
                </View>
              )}
              {screenshot.state === "partial" ? <Text style={[styles.notice, { color: theme.colors.mutedForeground }]}>Some protected content may be missing from this screenshot.</Text> : null}
              {preparing ? <Text style={[styles.notice, { color: theme.colors.mutedForeground }]}>Preparing Feedback…</Text> : null}
              {error ? (
                <Text accessibilityLiveRegion="polite" style={[styles.error, { color: theme.colors.error }]}>
                  {error}
                </Text>
              ) : null}

              <Pressable accessibilityRole="button" disabled={!canSubmit} onPress={() => void submit()} style={[styles.primaryButton, { backgroundColor: theme.colors.primary }, !canSubmit && styles.disabledButton]}>
                <Text style={[styles.primaryButtonText, { color: theme.colors.primaryForeground }]}>{sending ? "Sending…" : "Send Feedback"}</Text>
              </Pressable>
              <Text style={[styles.footer, { color: theme.colors.mutedForeground }]}>Chalk includes safe Space state, journey, and diagnostic details. It never includes credentials, names, or message content outside this report. There is no reply channel.</Text>
            </ScrollView>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function screenshotDataUri(screenshot: FeedbackScreenshot): string | undefined {
  if (screenshot.state !== "captured" && screenshot.state !== "partial") return undefined;
  return `data:${screenshot.mime_type};base64,${screenshot.data_base64}`;
}

function categoryLabel(category: FeedbackCategory): string {
  if (category === "feature_request") return "Feature request";
  if (category === "bug") return "Bug";
  return "Other";
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Chalk could not send Feedback.";
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: Theme.colors.darkOverlay55 },
  backdrop: { ...StyleSheet.absoluteFillObject },
  sheet: { maxHeight: "92%", borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 24, paddingBottom: 36 },
  header: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", gap: 16, marginBottom: 20 },
  headerCopy: { flex: 1, gap: 4 },
  title: { ...Theme.typography.heading },
  subtitle: { ...Theme.typography.body },
  closeButton: { alignItems: "center", borderColor: Theme.colors.border, borderRadius: Theme.radius.full, borderWidth: 1, height: 36, justifyContent: "center", width: 36 },
  closeText: { fontSize: 24, lineHeight: 26 },
  content: { gap: 12, paddingBottom: 8 },
  label: { ...Theme.typography.label, marginTop: 4 },
  categoryRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  categoryButton: { borderRadius: 14, borderWidth: 1, paddingHorizontal: 13, paddingVertical: 10 },
  categoryText: { fontSize: 14, fontWeight: "700" },
  messageInput: { minHeight: 116, borderRadius: 14, borderWidth: 1, padding: 14, fontSize: 15, lineHeight: 21 },
  thumbnailFrame: { borderRadius: 16, overflow: "hidden", borderWidth: 1, borderColor: Theme.colors.border },
  thumbnail: { width: "100%", height: 170, backgroundColor: Theme.colors.surfaceMuted },
  thumbnailActions: { flexDirection: "row", gap: 16, paddingHorizontal: 12, paddingVertical: 8 },
  unavailable: { borderRadius: 14, borderWidth: 1, padding: 14, gap: 4 },
  unavailableText: { ...Theme.typography.body },
  smallButton: { alignSelf: "flex-start", paddingVertical: 6, paddingHorizontal: 2 },
  smallButtonText: { fontSize: 14, fontWeight: "700" },
  notice: { ...Theme.typography.meta },
  error: { ...Theme.typography.meta, fontWeight: "700" },
  primaryButton: { alignItems: "center", borderRadius: 14, justifyContent: "center", minHeight: 50, marginTop: 8, paddingHorizontal: 16 },
  primaryButtonText: { fontSize: 16, fontWeight: "800" },
  disabledButton: { opacity: 0.45 },
  footer: { ...Theme.typography.meta, marginTop: 4 },
  success: { gap: 12, paddingVertical: 28 },
  successTitle: { ...Theme.typography.subheading },
});
