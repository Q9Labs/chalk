import ActivityIcon from "@hugeicons/core-free-icons/dist/esm/Activity01Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/dist/esm/AlertCircleIcon";
import Clock01Icon from "@hugeicons/core-free-icons/dist/esm/Clock01Icon";
import Navigation03Icon from "@hugeicons/core-free-icons/dist/esm/Navigation03Icon";
import SmartPhone01Icon from "@hugeicons/core-free-icons/dist/esm/SmartPhone01Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { buildDevDiagnosticsCopyText, clearDevDiagnosticsLogs, getDevDiagnosticsState, recordDiagnosticsFailure, subscribeDevDiagnostics } from "@q9labsai/chalk-react-native/diagnostics";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

interface DevDiagnosticsSheetProps {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onClearSpaceContext: () => Promise<void>;
  readonly onResetDiagnostics: () => Promise<void> | void;
}

export function DevDiagnosticsSheet({ visible, onClose, onClearSpaceContext, onResetDiagnostics }: DevDiagnosticsSheetProps): React.JSX.Element {
  const insets = useSafeAreaInsets();
  const diagnostics = useSyncExternalStore(subscribeDevDiagnostics, getDevDiagnosticsState);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!visible) setCopied(false);
  }, [visible]);

  const copy = async () => {
    try {
      await Clipboard.setStringAsync(buildDevDiagnosticsCopyText());
      setCopied(true);
    } catch (cause) {
      recordDiagnosticsFailure("copy-diagnostics", cause instanceof Error ? cause.message : "Diagnostics could not be copied.");
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} visible={visible}>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>DIAGNOSTICS</Text>
            <Text style={styles.title}>Chalk Native</Text>
          </View>
          <Pressable onPress={onClose} style={styles.button}>
            <Text style={styles.buttonText}>Done</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.actions} horizontal showsHorizontalScrollIndicator={false}>
          <Action label={copied ? "Copied" : "Copy"} onPress={() => void copy()} />
          <Action label="Clear access" onPress={() => void onClearSpaceContext()} />
          <Action label="Clear timeline" onPress={clearDevDiagnosticsLogs} />
          <Action label="Reset" onPress={() => void onResetDiagnostics()} />
        </ScrollView>
        <ScrollView contentContainerStyle={styles.content}>
          {diagnostics.lastFailure ? (
            <Section icon={AlertCircleIcon} title="Last failure">
              <Row label="Source" value={diagnostics.lastFailure.source} />
              <Row label="Message" value={diagnostics.lastFailure.message} />
            </Section>
          ) : null}
          <Section icon={ActivityIcon} title="Connection">
            <Row label="Status" value={diagnostics.connection?.status} />
            <Row label="Failure" value={diagnostics.connection?.lastError?.message} />
          </Section>
          <Section icon={Navigation03Icon} title="Environment">
            <Row label="Target" value={diagnostics.environment.target} />
            <Row label="Build" value={diagnostics.environment.buildProfile} />
            <Row label="Route" value={diagnostics.environment.routeKind} />
            <Row label="Broker" value={diagnostics.environment.brokerUrl} />
            <Row label="Space" value={diagnostics.environment.routeSpaceId} />
          </Section>
          <Section icon={SmartPhone01Icon} title="Device">
            <Row label="Platform" value={diagnostics.device?.platform} />
            <Row label="OS" value={diagnostics.device?.osVersion} />
            <Row label="React Native" value={diagnostics.device?.reactNativeVersion} />
            <Row label="Model" value={diagnostics.device?.model} />
          </Section>
          <Section icon={Clock01Icon} title={`Timeline (${diagnostics.timeline.length})`}>
            {diagnostics.timeline.length === 0 ? <Text style={styles.muted}>No events captured.</Text> : null}
            {diagnostics.timeline.slice(0, 50).map((entry) => (
              <View key={entry.id} style={styles.timeline}>
                <Text style={entry.outcome === "error" ? styles.error : styles.label}>{entry.title}</Text>
                <Text style={styles.muted}>{entry.detail || entry.eventType}</Text>
              </View>
            ))}
          </Section>
        </ScrollView>
      </View>
    </Modal>
  );
}

function Action({ label, onPress }: { readonly label: string; readonly onPress: () => void }): React.JSX.Element {
  return (
    <Pressable onPress={onPress} style={styles.button}>
      <Text style={styles.buttonText}>{label}</Text>
    </Pressable>
  );
}

function Section({ icon, title, children }: { readonly icon: Parameters<typeof HugeiconsIcon>[0]["icon"]; readonly title: string; readonly children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <HugeiconsIcon color={Theme.colors.primary} icon={icon} size={16} />
        <Text style={styles.label}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function Row({ label, value }: { readonly label: string; readonly value: string | number | null | undefined }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.muted}>{label}</Text>
      <Text selectable style={styles.value}>
        {value === null || value === undefined || value === "" ? "—" : String(value)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: Theme.colors.background },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderBottomWidth: 1,
    borderBottomColor: Theme.colors.border,
    padding: Theme.spacing.xl,
  },
  eyebrow: { ...Theme.typography.eyebrow, color: Theme.colors.primary },
  title: { ...Theme.typography.subheading, color: Theme.colors.foreground },
  actions: { gap: 8, padding: 12 },
  button: {
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.secondary,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  buttonText: { color: Theme.colors.foreground, fontWeight: "700" },
  content: { gap: 14, padding: Theme.spacing.xl },
  section: {
    gap: 10,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    borderRadius: Theme.radius.xl,
    backgroundColor: Theme.colors.secondary,
    padding: Theme.spacing.lg,
  },
  sectionHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  label: { color: Theme.colors.foreground, fontWeight: "700" },
  row: { flexDirection: "row", justifyContent: "space-between", gap: 12 },
  value: { flex: 1, color: Theme.colors.foreground, textAlign: "right" },
  muted: { color: Theme.colors.mutedForeground },
  error: { color: Theme.colors.error, fontWeight: "700" },
  timeline: { gap: 3, borderTopWidth: 1, borderTopColor: Theme.colors.border, paddingTop: 10 },
});
