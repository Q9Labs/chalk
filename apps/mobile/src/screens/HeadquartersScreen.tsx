import { StatusBar } from "expo-status-bar";
import { useMemo } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Theme } from "../lib/theme";
import { GROQ_MODEL, RECORDING_CHUNK_SECONDS } from "../lib/headquarters/constants";
import { useDictationController } from "../lib/headquarters/useDictationController";

const formatDuration = (durationMs: number) => {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${minutes}:${String(seconds).padStart(2, "0")}`;
};

const statusCopy = {
  recording: "Recording",
  transcribing: "Transcribing",
  ready: "Ready",
  attention: "Needs attention",
  draft: "Draft",
};

export function HeadquartersScreen(): React.JSX.Element {
  const controller = useDictationController();

  const currentDuration = useMemo(() => formatDuration(controller.selectedRecording?.status === "recording" ? controller.recorderState.durationMillis : (controller.selectedRecording?.totalDurationMs ?? 0)), [controller.recorderState.durationMillis, controller.selectedRecording]);

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar style="light" />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          <Text style={styles.eyebrow}>Future personal meta app</Text>
          <Text style={styles.title}>Hasan Headquaters</Text>
          <Text style={styles.subtitle}>V1 ships one thing well: background dictation with rolling chunk uploads to Groq {GROQ_MODEL}, durable local recordings, and transcript assembly that can survive hours-long sessions.</Text>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Groq</Text>
          <Text style={styles.sectionBody}>Paste your personal Groq API key once. Recordings can still be captured without it, but transcription will wait in the queue until a key is available on this device.</Text>
          <TextInput autoCapitalize="none" autoCorrect={false} onChangeText={controller.setApiKeyDraft} placeholder="gsk_..." placeholderTextColor={Theme.colors.placeholder} secureTextEntry={true} style={styles.input} value={controller.apiKeyDraft} />
          <Pressable disabled={controller.isSavingApiKey} onPress={() => void controller.saveApiKey()} style={({ pressed }) => [styles.secondaryButton, pressed && styles.buttonPressed, controller.isSavingApiKey && styles.buttonDisabled]}>
            <Text style={styles.secondaryButtonText}>{controller.isSavingApiKey ? "Saving..." : "Save API key"}</Text>
          </Pressable>
        </View>

        <View style={styles.card}>
          <Text style={styles.sectionTitle}>Dictation</Text>
          <Text style={styles.sectionBody}>Screen-off and app-background recording are enabled. Each segment rolls every {Math.floor(RECORDING_CHUNK_SECONDS / 60)} minutes to keep file sizes small and request timeouts out of the user experience.</Text>

          <View style={styles.statRow}>
            <View style={styles.statPill}>
              <Text style={styles.statLabel}>Status</Text>
              <Text style={styles.statValue}>{controller.isRecording ? "Listening" : controller.isQueueRunning ? "Uploading" : "Idle"}</Text>
            </View>
            <View style={styles.statPill}>
              <Text style={styles.statLabel}>Current</Text>
              <Text style={styles.statValue}>{currentDuration}</Text>
            </View>
            <View style={styles.statPill}>
              <Text style={styles.statLabel}>Saved</Text>
              <Text style={styles.statValue}>{controller.recordings.length}</Text>
            </View>
          </View>

          <Pressable
            disabled={controller.isHydrating}
            onPress={() => void (controller.isRecording ? controller.stopRecording() : controller.startRecording())}
            style={({ pressed }) => [styles.primaryButton, controller.isRecording && styles.stopButton, pressed && styles.buttonPressed, controller.isHydrating && styles.buttonDisabled]}
          >
            <Text style={styles.primaryButtonText}>{controller.isHydrating ? "Loading..." : controller.isRecording ? "Stop dictation" : "Start dictation"}</Text>
          </Pressable>

          {controller.notice ? <Text style={styles.noticeText}>{controller.notice}</Text> : null}
          {controller.error ? <Text style={styles.errorText}>{controller.error}</Text> : null}
        </View>

        <View style={styles.card}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Recordings</Text>
            {controller.isQueueRunning ? <ActivityIndicator color={Theme.colors.primary} /> : null}
          </View>

          {controller.recordings.length === 0 ? (
            <Text style={styles.emptyText}>No dictations yet. Start one and it will land here automatically.</Text>
          ) : (
            controller.recordings.map((recording) => {
              const isSelected = controller.selectedRecording?.id === recording.id;

              return (
                <Pressable key={recording.id} onPress={() => controller.selectRecording(recording.id)} style={({ pressed }) => [styles.recordingRow, isSelected && styles.recordingRowActive, pressed && styles.buttonPressed]}>
                  <View style={styles.recordingRowHeader}>
                    <Text style={styles.recordingTitle}>{recording.title}</Text>
                    <Text style={styles.recordingStatus}>{statusCopy[recording.status as keyof typeof statusCopy] ?? recording.status}</Text>
                  </View>
                  <Text style={styles.recordingMeta}>
                    {formatDuration(recording.totalDurationMs)} • {recording.chunks.length} chunks • {new Date(recording.startedAt).toLocaleString()}
                  </Text>
                  <Text numberOfLines={2} style={styles.recordingPreview}>
                    {recording.transcript || recording.error || "Transcript is still building."}
                  </Text>
                </Pressable>
              );
            })
          )}
        </View>

        {controller.selectedRecording ? (
          <View style={styles.card}>
            <Text style={styles.sectionTitle}>Transcript</Text>
            <Text style={styles.sectionBody}>{controller.selectedRecording.transcript || "Chunks are still waiting to transcribe, or this recording needs a Groq API key before the queue can run."}</Text>
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: Theme.colors.background,
  },
  content: {
    paddingHorizontal: 20,
    paddingBottom: 48,
    gap: 18,
  },
  hero: {
    paddingTop: 8,
    gap: 10,
  },
  eyebrow: {
    ...Theme.typography.eyebrow,
    color: "#8ef2e8",
  },
  title: {
    ...Theme.typography.title,
    color: Theme.colors.foreground,
  },
  subtitle: {
    ...Theme.typography.body,
    color: "#bcc5ce",
  },
  card: {
    backgroundColor: "#11161c",
    borderRadius: 22,
    padding: 18,
    borderWidth: 1,
    borderColor: "rgba(142, 242, 232, 0.1)",
    gap: 14,
  },
  sectionHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  sectionTitle: {
    ...Theme.typography.subheading,
    color: Theme.colors.foreground,
  },
  sectionBody: {
    ...Theme.typography.body,
    color: "#b7c0ca",
  },
  input: {
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.08)",
    borderRadius: 14,
    backgroundColor: "#0b1015",
    color: Theme.colors.foreground,
    paddingHorizontal: 14,
    paddingVertical: 14,
    fontSize: 15,
  },
  statRow: {
    flexDirection: "row",
    gap: 10,
  },
  statPill: {
    flex: 1,
    backgroundColor: "#0b1015",
    borderRadius: 16,
    padding: 12,
    gap: 4,
  },
  statLabel: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
  },
  statValue: {
    fontSize: 18,
    fontWeight: "700",
    color: Theme.colors.foreground,
  },
  primaryButton: {
    minHeight: 54,
    borderRadius: 18,
    backgroundColor: "#8ef2e8",
    alignItems: "center",
    justifyContent: "center",
  },
  stopButton: {
    backgroundColor: "#ff7f6b",
  },
  secondaryButton: {
    minHeight: 46,
    borderRadius: 16,
    backgroundColor: "#1d2832",
    alignItems: "center",
    justifyContent: "center",
  },
  primaryButtonText: {
    fontSize: 16,
    fontWeight: "800",
    color: "#051116",
  },
  secondaryButtonText: {
    fontSize: 15,
    fontWeight: "700",
    color: Theme.colors.foreground,
  },
  buttonPressed: {
    opacity: 0.86,
  },
  buttonDisabled: {
    opacity: 0.55,
  },
  noticeText: {
    ...Theme.typography.meta,
    color: "#8ef2e8",
  },
  errorText: {
    ...Theme.typography.meta,
    color: "#ff8e8e",
  },
  emptyText: {
    ...Theme.typography.body,
    color: Theme.colors.mutedForeground,
  },
  recordingRow: {
    borderRadius: 18,
    backgroundColor: "#0b1015",
    padding: 14,
    gap: 8,
  },
  recordingRowActive: {
    borderWidth: 1,
    borderColor: "rgba(142, 242, 232, 0.35)",
  },
  recordingRowHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  recordingTitle: {
    flex: 1,
    fontSize: 16,
    fontWeight: "700",
    color: Theme.colors.foreground,
  },
  recordingStatus: {
    fontSize: 13,
    fontWeight: "700",
    color: "#8ef2e8",
  },
  recordingMeta: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
  },
  recordingPreview: {
    ...Theme.typography.body,
    color: "#d7dde4",
  },
});
