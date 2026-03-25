import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Modal, Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import { buildDevDiagnosticsCopyText, clearDevDiagnosticsLogs, getDevDiagnosticsState, subscribeDevDiagnostics } from "../lib/dev-diagnostics";
import { Theme } from "../lib/theme";

interface DevDiagnosticsSheetProps {
  visible: boolean;
  onClose: () => void;
  onRefreshAuth: () => Promise<void>;
  isRefreshingAuth?: boolean;
}

const codeFont = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const renderValue = (value: string | number | null | undefined) => (value === null || value === undefined || value === "" ? "—" : String(value));

export function DevDiagnosticsSheet({ visible, onClose, onRefreshAuth, isRefreshingAuth = false }: DevDiagnosticsSheetProps): React.JSX.Element {
  const diagnostics = useSyncExternalStore(subscribeDevDiagnostics, getDevDiagnosticsState);
  const [copyState, setCopyState] = useState<"idle" | "copied">("idle");

  useEffect(() => {
    if (!visible) {
      setCopyState("idle");
    }
  }, [visible]);

  const requestItems = useMemo(() => diagnostics.requests.slice(0, 40), [diagnostics.requests]);

  const handleCopy = async () => {
    await Clipboard.setStringAsync(buildDevDiagnosticsCopyText());
    setCopyState("copied");
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent={false} visible={visible}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>DEV DIAGNOSTICS</Text>
            <Text style={styles.title}>Mobile debug snapshot</Text>
          </View>
          <Pressable onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeButtonText}>Close</Text>
          </Pressable>
        </View>

        <View style={styles.actionRow}>
          <Pressable onPress={handleCopy} style={styles.primaryAction}>
            <Text style={styles.primaryActionText}>{copyState === "copied" ? "Copied" : "Copy all"}</Text>
          </Pressable>
          <Pressable disabled={isRefreshingAuth} onPress={() => void onRefreshAuth()} style={[styles.secondaryAction, isRefreshingAuth && styles.actionDisabled]}>
            <Text style={styles.secondaryActionText}>{isRefreshingAuth ? "Refreshing..." : "Refresh auth"}</Text>
          </Pressable>
          <Pressable onPress={clearDevDiagnosticsLogs} style={styles.secondaryAction}>
            <Text style={styles.secondaryActionText}>Clear logs</Text>
          </Pressable>
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          <Section title="Target">
            <Row label="Target" value={diagnostics.env.target} />
            <Row label="Build" value={diagnostics.env.buildProfile} />
            <Row label="Route" value={diagnostics.env.routeKind} />
            <Row label="Room" value={diagnostics.env.routeRoomId} />
            <Row label="Source" value={diagnostics.env.routeSource} />
            <Block label="API URL" value={diagnostics.env.apiUrl} />
            <Block label="WS URL" value={diagnostics.env.wsUrl} />
          </Section>

          <Section title="Auth">
            <Row label="Host mode" value={diagnostics.auth.hostMode} />
            <Row label="Configured key" value={diagnostics.auth.configuredHostApiKeyPreview} />
            <Row label="Local key" value={diagnostics.auth.localDevHostApiKeyPreview} />
            <Row label="Join token" value={diagnostics.auth.joinTokenPreview} />
            <Row label="Join access" value={diagnostics.auth.joinAccessTokenPreview} />
            <Row label="Latest token" value={diagnostics.auth.latestAccessTokenPreview} />
            <Row label="Token source" value={diagnostics.auth.latestAccessTokenSource} />
          </Section>

          <Section title="Server Auth Debug">
            <Row label="User" value={diagnostics.auth.authInfo?.userId} />
            <Row label="Tenant" value={diagnostics.auth.authInfo?.tenantId} />
            <Row label="Room" value={diagnostics.auth.authInfo?.roomId} />
            <Row label="Display" value={diagnostics.auth.authInfo?.displayName} />
            <Row label="Role" value={diagnostics.auth.authInfo?.role} />
            <Row label="Expires in" value={diagnostics.auth.authInfo?.tokenExpiresInSeconds} />
            <Row label="Request ID" value={diagnostics.auth.authInfo?.requestId} />
            <Row label="Trace ID" value={diagnostics.auth.authInfo?.traceId} />
            <Block label="Scopes" value={diagnostics.auth.authInfo?.scopes.join(", ")} />
            <Block label="Permissions" value={diagnostics.auth.authInfo ? JSON.stringify(diagnostics.auth.authInfo.permissions) : null} />
            <Block label="API build" value={diagnostics.auth.authInfo ? `${diagnostics.auth.authInfo.apiVersion} @ ${diagnostics.auth.authInfo.apiCommitSha}` : null} />
          </Section>

          <Section title={`Requests (${diagnostics.requests.length})`}>
            {requestItems.length === 0 ? <Text style={styles.emptyText}>No requests captured yet.</Text> : null}
            {requestItems.map((request) => (
              <View key={request.id} style={styles.logCard}>
                <Text selectable={true} style={styles.logLine}>
                  [{request.timestamp}] {request.method || request.eventType} {request.path || request.url || ""}
                </Text>
                <Text selectable={true} style={styles.logMeta}>
                  {request.outcome.toUpperCase()} · status {renderValue(request.statusCode)} · {renderValue(request.durationMs)} ms
                </Text>
                <Text selectable={true} style={styles.logMeta}>
                  req {renderValue(request.requestId)} · trace {renderValue(request.traceId)} · cf {renderValue(request.cfRay)}
                </Text>
                {request.errorMessage ? (
                  <Text selectable={true} style={styles.logError}>
                    {request.errorMessage}
                  </Text>
                ) : null}
              </View>
            ))}
          </Section>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string | number | null | undefined }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text selectable={true} style={styles.rowValue}>
        {renderValue(value)}
      </Text>
    </View>
  );
}

function Block({ label, value }: { label: string | null | undefined; value: string | null | undefined }): React.JSX.Element {
  return (
    <View style={styles.block}>
      <Text style={styles.rowLabel}>{renderValue(label)}</Text>
      <Text selectable={true} style={styles.blockValue}>
        {renderValue(value)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: Theme.colors.background,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderBottomWidth: 1,
    borderBottomColor: "rgba(255,255,255,0.08)",
  },
  eyebrow: {
    color: Theme.colors.primary,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 1,
  },
  title: {
    color: Theme.colors.foreground,
    fontSize: 22,
    fontWeight: "800",
    marginTop: 4,
  },
  closeButton: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 999,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  closeButtonText: {
    color: Theme.colors.foreground,
    fontWeight: "700",
  },
  actionRow: {
    flexDirection: "row",
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 14,
    flexWrap: "wrap",
  },
  primaryAction: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: Theme.colors.primary,
  },
  primaryActionText: {
    color: "#041110",
    fontWeight: "800",
  },
  secondaryAction: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderRadius: 12,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  secondaryActionText: {
    color: Theme.colors.foreground,
    fontWeight: "700",
  },
  actionDisabled: {
    opacity: 0.6,
  },
  content: {
    padding: 20,
    gap: 16,
  },
  section: {
    borderRadius: 18,
    padding: 16,
    backgroundColor: "rgba(255,255,255,0.04)",
    gap: 10,
  },
  sectionTitle: {
    color: Theme.colors.foreground,
    fontSize: 16,
    fontWeight: "800",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  rowLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  rowValue: {
    flex: 1,
    color: Theme.colors.foreground,
    textAlign: "right",
    fontFamily: codeFont,
    fontSize: 12,
  },
  block: {
    gap: 6,
  },
  blockValue: {
    color: Theme.colors.foreground,
    fontFamily: codeFont,
    fontSize: 12,
  },
  emptyText: {
    color: Theme.colors.mutedForeground,
  },
  logCard: {
    borderRadius: 14,
    padding: 12,
    backgroundColor: "#0f1014",
    gap: 4,
  },
  logLine: {
    color: Theme.colors.foreground,
    fontFamily: codeFont,
    fontSize: 11,
  },
  logMeta: {
    color: Theme.colors.mutedForeground,
    fontFamily: codeFont,
    fontSize: 11,
  },
  logError: {
    color: Theme.colors.error,
    fontFamily: codeFont,
    fontSize: 11,
  },
});
