import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { HugeiconsIcon } from "@hugeicons/react-native";
import ActivityIcon from "@hugeicons/core-free-icons/dist/esm/Activity01Icon";
import AlertCircleIcon from "@hugeicons/core-free-icons/dist/esm/AlertCircleIcon";
import Clock01Icon from "@hugeicons/core-free-icons/dist/esm/Clock01Icon";
import Database01Icon from "@hugeicons/core-free-icons/dist/esm/Database01Icon";
import Key01Icon from "@hugeicons/core-free-icons/dist/esm/Key01Icon";
import Navigation03Icon from "@hugeicons/core-free-icons/dist/esm/Navigation03Icon";
import Settings01Icon from "@hugeicons/core-free-icons/dist/esm/Settings01Icon";
import SmartPhone01Icon from "@hugeicons/core-free-icons/dist/esm/SmartPhone01Icon";
import { SafeAreaView } from "react-native-safe-area-context";
import { Theme } from "@q9labs/chalk-react-native";
import { buildDevDiagnosticsCopyText, clearDevDiagnosticsLogs, getDevDiagnosticsState, recordDiagnosticsFailure, subscribeDevDiagnostics } from "../lib/dev-diagnostics";

interface DevDiagnosticsSheetProps {
  visible: boolean;
  onClose: () => void;
  onRefreshAuth: () => Promise<void>;
  onForceDisconnect: () => Promise<void>;
  onClearJoinContext: () => Promise<void>;
  onClearHostAuth: () => Promise<void>;
  onResetDiagnostics: () => Promise<void> | void;
  isRefreshingAuth?: boolean;
}

const codeFont = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});

const renderValue = (value: string | number | boolean | null | undefined) => (value === null || value === undefined || value === "" ? "—" : String(value));

const formatTime = (isoString: string | null | undefined) => {
  if (!isoString) return "—";
  try {
    const d = new Date(isoString);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
  } catch {
    return "—";
  }
};

export function DevDiagnosticsSheet({ visible, onClose, onRefreshAuth, onForceDisconnect, onClearJoinContext, onClearHostAuth, onResetDiagnostics, isRefreshingAuth = false }: DevDiagnosticsSheetProps): React.JSX.Element {
  const diagnostics = useSyncExternalStore(subscribeDevDiagnostics, getDevDiagnosticsState);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (!visible) {
      setCopyState("idle");
    }
  }, [visible]);

  const requestItems = useMemo(() => diagnostics.requests.slice(0, 30), [diagnostics.requests]);
  const timelineItems = useMemo(() => diagnostics.timeline.slice(0, 50), [diagnostics.timeline]);

  const handleCopy = async () => {
    try {
      const copyText = buildDevDiagnosticsCopyText();
      const clipboardModule = Clipboard as typeof Clipboard & {
        setString?: (value: string) => void;
      };

      clipboardModule.setString?.(copyText);
      await Clipboard.setStringAsync(copyText);

      const copiedText = await Clipboard.getStringAsync();
      if (copiedText !== copyText) {
        throw new Error("Clipboard verification failed");
      }

      setCopyState("copied");
    } catch (error) {
      setCopyState("failed");
      recordDiagnosticsFailure("copy-debug", error instanceof Error ? error.message : "Copy full debug failed");
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent={false} visible={visible}>
      <SafeAreaView style={styles.screen}>
        <View style={styles.header}>
          <View>
            <Text style={styles.eyebrow}>LOCAL DEV DIAGNOSTICS</Text>
            <Text style={styles.title}>Mobile debug snapshot</Text>
          </View>
          <Pressable onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeButtonText}>Close</Text>
          </Pressable>
        </View>

        <View style={styles.actionRow}>
          <ActionButton label={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy Full Debug"} onPress={handleCopy} primary={true} />
          <ActionButton disabled={isRefreshingAuth} label={isRefreshingAuth ? "Refreshing..." : "Refresh auth"} onPress={() => void onRefreshAuth()} />
          <ActionButton label="Force disconnect" onPress={() => void onForceDisconnect()} />
          <ActionButton label="Clear join" onPress={() => void onClearJoinContext()} />
          <ActionButton label="Clear host" onPress={() => void onClearHostAuth()} />
          <ActionButton label="Clear logs" onPress={clearDevDiagnosticsLogs} />
          <ActionButton label="Reset" onPress={() => void onResetDiagnostics()} />
        </View>

        <ScrollView contentContainerStyle={styles.content}>
          {diagnostics.lastFailure ? (
            <Section icon={AlertCircleIcon} title="Last Failure" color={Theme.colors.error}>
              <Row label="Reason" value={diagnostics.lastFailure.message} />
              <Row label="At" value={formatTime(diagnostics.lastFailure.occurredAt)} />
              <Block label="Source" value={diagnostics.lastFailure.source} />
            </Section>
          ) : null}

          <Section icon={SmartPhone01Icon} title="Native Device Info">
            <CompactGrid>
              <GridItem label="Platform" value={diagnostics.device?.platform} />
              <GridItem label="OS" value={diagnostics.device?.osVersion} />
              <GridItem label="RN" value={diagnostics.device?.reactNativeVersion} />
              <GridItem label="Model" value={diagnostics.device?.model} />
              <GridItem label="Brand" value={diagnostics.device?.brand} />
              <GridItem label="Maker" value={diagnostics.device?.manufacturer} />
              <GridItem label="Idiom" value={diagnostics.device?.interfaceIdiom} />
              <GridItem label="Hermes" value={diagnostics.device?.hermesEnabled} highlight={diagnostics.device?.hermesEnabled} />
            </CompactGrid>
            <Block label="Script URL" value={diagnostics.device?.scriptUrl} />
          </Section>

          <Section icon={ActivityIcon} title="Session Lifecycle Summary">
            <CompactGrid>
              <GridItem label="Phase" value={diagnostics.session?.phase} highlight={!!diagnostics.session?.phase} />
              <GridItem label="Room Status" value={diagnostics.session?.session.activeRoomStatus} />
              <GridItem label="WS Status" value={diagnostics.session?.session.websocketConnectionState} />
              <GridItem label="Connected" value={diagnostics.session?.isConnected} highlight={diagnostics.session?.isConnected} />
              <GridItem label="Joining" value={diagnostics.session?.isJoining} highlight={diagnostics.session?.isJoining} />
              <GridItem label="Has RTK" value={diagnostics.session?.session.activeRoomHasRtkMeeting} />
              <GridItem label="In-flight" value={diagnostics.session?.session.hasInFlightJoinPromise} />
              <GridItem label="Pending" value={diagnostics.session?.pendingJoinRequest !== null} />
              <GridItem label="Disposed" value={diagnostics.session?.session.isDisposed} />
            </CompactGrid>
            <View style={styles.gridFooter}>
              <Row label="Active Room" value={diagnostics.session?.session.activeRoomId} />
              <Row label="Room State ID" value={diagnostics.session?.session.roomStateRoomId} />
              <Row label="Last Join Error" value={diagnostics.session?.lastJoinError} />
            </View>
          </Section>

          <Section icon={Navigation03Icon} title="Target">
            <Row label="Target" value={diagnostics.env.target} />
            <Row label="Build" value={diagnostics.env.buildProfile} />
            <Row label="Route" value={diagnostics.env.routeKind} />
            <Row label="Room" value={diagnostics.env.routeRoomId} />
            <Row label="Source" value={diagnostics.env.routeSource} />
            <Block label="API URL" value={diagnostics.env.apiUrl} />
            <Block label="WS URL" value={diagnostics.env.wsUrl} />
          </Section>

          <Section icon={Key01Icon} title="Auth">
            <Row label="Host mode" value={diagnostics.auth.hostMode} />
            <Row label="Join token" value={diagnostics.auth.joinTokenPreview} />
            <Row label="Join access" value={diagnostics.auth.joinAccessTokenPreview} />
            <Row label="Latest token" value={diagnostics.auth.latestAccessTokenPreview} />
            <Row label="Source" value={diagnostics.auth.latestAccessTokenSource} />
          </Section>

          <Section icon={Clock01Icon} title={`Timeline (${diagnostics.timeline.length})`}>
            {timelineItems.length === 0 ? <Text style={styles.emptyText}>No events captured yet.</Text> : null}
            <View style={styles.timelineContainer}>
              {timelineItems.map((entry, i) => (
                <View key={entry.id} style={[styles.timelineItem, i === timelineItems.length - 1 && styles.timelineItemLast]}>
                  <View style={styles.timelineIndicator}>
                    <View style={[styles.timelineDot, entry.outcome === "error" && styles.timelineDotError, entry.outcome === "success" && styles.timelineDotSuccess]} />
                    {i !== timelineItems.length - 1 && <View style={styles.timelineLine} />}
                  </View>
                  <View style={styles.timelineContent}>
                    <View style={styles.timelineHeader}>
                      <Text style={styles.timelineTitle}>{entry.title}</Text>
                      <Text style={styles.timelineTimestamp}>{formatTime(entry.timestamp)}</Text>
                    </View>
                    {entry.detail ? (
                      <Text selectable={true} style={styles.timelineDetail}>
                        {entry.detail}
                      </Text>
                    ) : null}
                  </View>
                </View>
              ))}
            </View>
          </Section>

          <Section icon={Settings01Icon} title={`Requests (${diagnostics.requests.length})`}>
            {requestItems.length === 0 ? <Text style={styles.emptyText}>No requests captured yet.</Text> : null}
            {requestItems.map((request) => (
              <View key={request.id} style={styles.logCard}>
                <View style={styles.logHeader}>
                  <Text style={styles.logMethod}>{request.method || "EVENT"}</Text>
                  <Text style={styles.logStatus}>{renderValue(request.statusCode)}</Text>
                  <Text style={styles.logTimestamp}>{formatTime(request.timestamp)}</Text>
                </View>
                <Text selectable={true} style={styles.logPath}>
                  {request.path || request.url || request.eventType}
                </Text>
                <View style={styles.logFooter}>
                  <Text style={[styles.logOutcome, request.outcome === "error" && styles.logError]}>{request.outcome.toUpperCase()}</Text>
                  <Text style={styles.logMeta}>
                    {renderValue(request.durationMs)} ms · {renderValue(request.cfRay)}
                  </Text>
                </View>
                {request.errorMessage ? (
                  <Text selectable={true} style={styles.logErrorText}>
                    {request.errorMessage}
                  </Text>
                ) : null}
              </View>
            ))}
          </Section>

          <Section icon={Database01Icon} title="Server Auth Debug">
            <Row label="User" value={diagnostics.auth.authInfo?.userId} />
            <Row label="Tenant" value={diagnostics.auth.authInfo?.tenantId} />
            <Row label="Room" value={diagnostics.auth.authInfo?.roomId} />
            <Row label="Role" value={diagnostics.auth.authInfo?.role} />
            <Row label="Expires" value={formatTime(diagnostics.auth.authInfo?.tokenExpiresAt)} />
            <Row label="Trace" value={diagnostics.auth.authInfo?.traceId} />
            <Block label="API" value={diagnostics.auth.authInfo ? `${diagnostics.auth.authInfo.apiVersion} @ ${diagnostics.auth.authInfo.apiCommitSha}` : null} />
          </Section>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function CompactGrid({ children }: { children: React.ReactNode }) {
  return <View style={styles.compactGrid}>{children}</View>;
}

function GridItem({ label, value, highlight = false }: { label: string; value: string | number | boolean | null | undefined; highlight?: boolean }) {
  return (
    <View style={styles.gridItem}>
      <Text style={styles.gridLabel}>{label}</Text>
      <Text numberOfLines={1} ellipsizeMode="tail" style={[styles.gridValue, highlight && styles.gridValueHighlight]}>
        {renderValue(value)}
      </Text>
    </View>
  );
}

function ActionButton({ label, onPress, disabled = false, primary = false }: { label: string; onPress: () => void; disabled?: boolean; primary?: boolean }): React.JSX.Element {
  return (
    <Pressable disabled={disabled} onPress={onPress} style={[primary ? styles.primaryAction : styles.secondaryAction, disabled && styles.actionDisabled]}>
      <Text style={primary ? styles.primaryActionText : styles.secondaryActionText}>{label}</Text>
    </Pressable>
  );
}

function Section({ title, icon, children, color }: { title: string; icon: any; children: React.ReactNode; color?: string }): React.JSX.Element {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <HugeiconsIcon icon={icon} size={16} color={color || Theme.colors.primary} />
        <Text style={[styles.sectionTitle, color ? { color } : null]}>{title}</Text>
      </View>
      {children}
    </View>
  );
}

function Row({ label, value }: { label: string; value: string | number | boolean | null | undefined }): React.JSX.Element {
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <Text selectable={true} style={styles.rowValue}>
        {renderValue(value)}
      </Text>
    </View>
  );
}

function Block({ label, value }: { label: string; value: string | null | undefined }): React.JSX.Element {
  return (
    <View style={styles.block}>
      <Text style={styles.rowLabel}>{label}</Text>
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
    gap: 8,
    paddingHorizontal: 20,
    paddingTop: 14,
    flexWrap: "wrap",
  },
  primaryAction: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: Theme.colors.primary,
  },
  primaryActionText: {
    color: "#041110",
    fontWeight: "800",
    fontSize: 13,
  },
  secondaryAction: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  secondaryActionText: {
    color: Theme.colors.foreground,
    fontWeight: "700",
    fontSize: 13,
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
    gap: 12,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    marginBottom: 4,
  },
  sectionTitle: {
    color: Theme.colors.foreground,
    fontSize: 14,
    fontWeight: "800",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  },
  compactGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
  },
  gridItem: {
    width: "31.5%",
    backgroundColor: "rgba(255,255,255,0.03)",
    padding: 8,
    borderRadius: 10,
    gap: 2,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.03)",
  },
  gridLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 9,
    fontWeight: "700",
    textTransform: "uppercase",
  },
  gridValue: {
    color: Theme.colors.foreground,
    fontFamily: codeFont,
    fontSize: 10,
    fontWeight: "600",
  },
  gridValueHighlight: {
    color: Theme.colors.primary,
  },
  gridFooter: {
    gap: 6,
    marginTop: 4,
    paddingTop: 8,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.05)",
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
  },
  rowLabel: {
    color: Theme.colors.mutedForeground,
    fontSize: 11,
    fontWeight: "700",
    textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  rowValue: {
    flex: 1,
    color: Theme.colors.foreground,
    textAlign: "right",
    fontFamily: codeFont,
    fontSize: 11,
  },
  block: {
    gap: 4,
  },
  blockValue: {
    color: Theme.colors.foreground,
    fontFamily: codeFont,
    fontSize: 11,
    lineHeight: 16,
  },
  emptyText: {
    color: Theme.colors.mutedForeground,
    fontSize: 12,
    fontStyle: "italic",
  },
  timelineContainer: {
    paddingLeft: 4,
  },
  timelineItem: {
    flexDirection: "row",
    gap: 12,
    minHeight: 40,
  },
  timelineItemLast: {
    minHeight: 0,
  },
  timelineIndicator: {
    alignItems: "center",
    width: 8,
  },
  timelineDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: Theme.colors.mutedForeground,
    marginTop: 4,
  },
  timelineDotError: {
    backgroundColor: Theme.colors.error,
  },
  timelineDotSuccess: {
    backgroundColor: Theme.colors.success,
  },
  timelineLine: {
    flex: 1,
    width: 2,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  timelineContent: {
    flex: 1,
    paddingBottom: 12,
  },
  timelineHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  timelineTitle: {
    color: Theme.colors.foreground,
    fontSize: 12,
    fontWeight: "700",
  },
  timelineTimestamp: {
    color: Theme.colors.mutedForeground,
    fontFamily: codeFont,
    fontSize: 9,
  },
  timelineDetail: {
    color: Theme.colors.mutedForeground,
    fontSize: 11,
    marginTop: 2,
  },
  logCard: {
    borderRadius: 12,
    padding: 10,
    backgroundColor: "#0f1014",
    gap: 4,
    marginBottom: 8,
    borderWidth: 1,
    borderColor: "rgba(255,255,255,0.03)",
  },
  logHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  logMethod: {
    color: Theme.colors.primary,
    fontFamily: codeFont,
    fontSize: 10,
    fontWeight: "700",
  },
  logStatus: {
    color: Theme.colors.foreground,
    fontFamily: codeFont,
    fontSize: 10,
  },
  logTimestamp: {
    flex: 1,
    textAlign: "right",
    color: Theme.colors.mutedForeground,
    fontFamily: codeFont,
    fontSize: 9,
  },
  logPath: {
    color: Theme.colors.foreground,
    fontFamily: codeFont,
    fontSize: 11,
  },
  logFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 2,
  },
  logOutcome: {
    fontSize: 9,
    fontWeight: "800",
    color: Theme.colors.success,
  },
  logError: {
    color: Theme.colors.error,
  },
  logMeta: {
    color: Theme.colors.mutedForeground,
    fontFamily: codeFont,
    fontSize: 9,
  },
  logErrorText: {
    color: Theme.colors.error,
    fontFamily: codeFont,
    fontSize: 10,
    marginTop: 2,
  },
});
