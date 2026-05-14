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
import { useSafeAreaInsets } from "react-native-safe-area-context";
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
  const insets = useSafeAreaInsets();
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
      setTimeout(() => setCopyState("idle"), 2000);
    } catch (error) {
      setCopyState("failed");
      recordDiagnosticsFailure("copy-debug", error instanceof Error ? error.message : "Copy full debug failed");
    }
  };

  return (
    <Modal animationType="slide" onRequestClose={onClose} transparent={false} visible={visible}>
      <View style={[styles.screen, { paddingTop: insets.top }]}>
        <View style={styles.header}>
          <View style={styles.headerCopy}>
            <Text style={styles.eyebrow}>DIAGNOSTICS</Text>
            <Text style={styles.title}>Mobile Debug</Text>
          </View>
          <Pressable onPress={onClose} style={styles.closeButton}>
            <Text style={styles.closeButtonText}>Done</Text>
          </Pressable>
        </View>

        <View style={styles.stickyActions}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.actionRow}>
            <ActionButton label={copyState === "copied" ? "Copied!" : copyState === "failed" ? "Failed" : "Copy Debug"} onPress={handleCopy} primary={true} />
            <ActionButton disabled={isRefreshingAuth} label={isRefreshingAuth ? "Refreshing..." : "Refresh Auth"} onPress={() => void onRefreshAuth()} />
            <ActionButton label="Disconnect" onPress={() => void onForceDisconnect()} />
            <ActionButton label="Clear Join" onPress={() => void onClearJoinContext()} />
            <ActionButton label="Clear Host" onPress={() => void onClearHostAuth()} />
            <ActionButton label="Clear Logs" onPress={clearDevDiagnosticsLogs} />
            <ActionButton label="Reset" onPress={() => void onResetDiagnostics()} />
          </ScrollView>
        </View>

        <ScrollView contentContainerStyle={styles.content} bounces={true} showsVerticalScrollIndicator={false}>
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
              <GridItem label="Hermes" value={diagnostics.device?.hermesEnabled ? "Yes" : "No"} highlight={diagnostics.device?.hermesEnabled} />
            </CompactGrid>
            <Block label="Script URL" value={diagnostics.device?.scriptUrl} />
          </Section>

          <Section icon={ActivityIcon} title="Session Summary">
            <CompactGrid>
              <GridItem label="Phase" value={diagnostics.session?.phase} highlight={!!diagnostics.session?.phase} />
              <GridItem label="Room Status" value={diagnostics.session?.session.activeRoomStatus} />
              <GridItem label="WS Status" value={diagnostics.session?.session.websocketConnectionState} />
              <GridItem label="Connected" value={diagnostics.session?.isConnected ? "Yes" : "No"} highlight={diagnostics.session?.isConnected} />
              <GridItem label="Joining" value={diagnostics.session?.isJoining ? "Yes" : "No"} highlight={diagnostics.session?.isJoining} />
              <GridItem label="RTK Meeting" value={diagnostics.session?.session.activeRoomHasRtkMeeting ? "Yes" : "No"} />
            </CompactGrid>
            <View style={styles.gridFooter}>
              <Row label="Active Room" value={diagnostics.session?.session.activeRoomId} />
              <Row label="Last Join Error" value={diagnostics.session?.lastJoinError} />
            </View>
          </Section>

          <Section icon={Navigation03Icon} title="Target Environment">
            <Row label="Target" value={diagnostics.env.target} />
            <Row label="Build" value={diagnostics.env.buildProfile} />
            <Row label="Route" value={diagnostics.env.routeKind} />
            <Row label="Room" value={diagnostics.env.routeRoomId} />
            <Block label="API URL" value={diagnostics.env.apiUrl} />
            <Block label="WS URL" value={diagnostics.env.wsUrl} />
          </Section>

          <Section icon={Key01Icon} title="Authentication">
            <Row label="Host Mode" value={diagnostics.auth.hostMode} />
            <Row label="Join Token" value={diagnostics.auth.joinTokenPreview} />
            <Row label="Join Access" value={diagnostics.auth.joinAccessTokenPreview} />
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
                  <View style={styles.logTag}>
                    <Text style={styles.logMethod}>{request.method || "EVENT"}</Text>
                  </View>
                  <Text style={styles.logStatus}>{renderValue(request.statusCode)}</Text>
                  <Text style={styles.logTimestamp}>{formatTime(request.timestamp)}</Text>
                </View>
                <Text selectable={true} style={styles.logPath}>
                  {request.path || request.url || request.eventType}
                </Text>
                <View style={styles.logFooter}>
                  <Text style={[styles.logOutcome, request.outcome === "error" && styles.logError]}>{request.outcome.toUpperCase()}</Text>
                  <Text style={styles.logMeta}>
                    {renderValue(request.durationMs)}ms · {renderValue(request.cfRay)}
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
            <Block label="API" value={diagnostics.auth.authInfo ? `${diagnostics.auth.authInfo.apiVersion} @ ${diagnostics.auth.authInfo.apiCommitSha}` : null} />
          </Section>
        </ScrollView>
      </View>
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
    <Pressable disabled={disabled} onPress={onPress} style={({ pressed }) => [primary ? styles.primaryAction : styles.secondaryAction, pressed && !disabled && styles.actionPressed, disabled && styles.actionDisabled]}>
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
    paddingHorizontal: Theme.spacing["2xl"],
    paddingVertical: Theme.spacing.xl,
    borderBottomWidth: 1,
    borderBottomColor: Theme.colors.border,
  },
  headerCopy: {
    gap: 2,
  },
  eyebrow: {
    ...Theme.typography.eyebrow,
    color: Theme.colors.primary,
  },
  title: {
    ...Theme.typography.subheading,
    color: Theme.colors.foreground,
  },
  closeButton: {
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.sm,
    borderRadius: Theme.radius.full,
    backgroundColor: Theme.colors.secondary,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  closeButtonText: {
    ...Theme.typography.label,
    color: Theme.colors.foreground,
  },
  stickyActions: {
    backgroundColor: Theme.colors.background,
    borderBottomWidth: 1,
    borderBottomColor: Theme.colors.border,
  },
  actionRow: {
    flexDirection: "row",
    gap: Theme.spacing.sm,
    paddingHorizontal: Theme.spacing["2xl"],
    paddingVertical: Theme.spacing.md,
  },
  primaryAction: {
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.sm,
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.primary,
  },
  primaryActionText: {
    color: "white",
    fontWeight: "800",
    fontSize: 13,
  },
  secondaryAction: {
    paddingHorizontal: Theme.spacing.lg,
    paddingVertical: Theme.spacing.sm,
    borderRadius: Theme.radius.lg,
    backgroundColor: Theme.colors.secondary,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  secondaryActionText: {
    color: Theme.colors.foreground,
    fontWeight: "700",
    fontSize: 13,
  },
  actionPressed: {
    opacity: 0.8,
    transform: [{ scale: 0.98 }],
  },
  actionDisabled: {
    opacity: 0.5,
  },
  content: {
    padding: Theme.spacing["2xl"],
    gap: Theme.spacing.lg,
  },
  section: {
    borderRadius: Theme.radius.xl,
    padding: Theme.spacing.lg,
    backgroundColor: Theme.colors.secondary,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    gap: Theme.spacing.md,
  },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Theme.spacing.sm,
    marginBottom: Theme.spacing.xs,
  },
  sectionTitle: {
    ...Theme.typography.label,
    color: Theme.colors.foreground,
    textTransform: "uppercase",
    letterSpacing: 1,
    fontSize: 12,
  },
  compactGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: Theme.spacing.sm,
  },
  gridItem: {
    width: "30.5%",
    backgroundColor: "rgba(255,255,255,0.03)",
    padding: Theme.spacing.sm,
    borderRadius: Theme.radius.md,
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
    gap: Theme.spacing.xs,
    marginTop: Theme.spacing.xs,
    paddingTop: Theme.spacing.md,
    borderTopWidth: 1,
    borderTopColor: Theme.colors.border,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: Theme.spacing.md,
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
    gap: Theme.spacing.xs,
  },
  blockValue: {
    color: Theme.colors.foreground,
    fontFamily: codeFont,
    fontSize: 11,
    lineHeight: 16,
  },
  emptyText: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
    fontStyle: "italic",
  },
  timelineContainer: {
    paddingLeft: Theme.spacing.xs,
  },
  timelineItem: {
    flexDirection: "row",
    gap: Theme.spacing.md,
    minHeight: 48,
  },
  timelineItemLast: {
    minHeight: 0,
  },
  timelineIndicator: {
    alignItems: "center",
    width: 8,
  },
  timelineDot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: Theme.colors.mutedForeground,
    marginTop: 6,
    borderWidth: 2,
    borderColor: Theme.colors.secondary,
  },
  timelineDotError: {
    backgroundColor: Theme.colors.error,
  },
  timelineDotSuccess: {
    backgroundColor: Theme.colors.success,
  },
  timelineLine: {
    flex: 1,
    width: 1.5,
    backgroundColor: Theme.colors.border,
  },
  timelineContent: {
    flex: 1,
    paddingBottom: Theme.spacing.md,
  },
  timelineHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  timelineTitle: {
    ...Theme.typography.label,
    color: Theme.colors.foreground,
    fontSize: 13,
  },
  timelineTimestamp: {
    color: Theme.colors.mutedForeground,
    fontFamily: codeFont,
    fontSize: 9,
  },
  timelineDetail: {
    ...Theme.typography.meta,
    color: Theme.colors.mutedForeground,
    marginTop: 2,
  },
  logCard: {
    borderRadius: Theme.radius.lg,
    padding: Theme.spacing.md,
    backgroundColor: "#0d0d10",
    gap: Theme.spacing.xs,
    marginBottom: Theme.spacing.sm,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  logHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: Theme.spacing.sm,
  },
  logTag: {
    backgroundColor: "rgba(27, 182, 166, 0.1)",
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  logMethod: {
    color: Theme.colors.primary,
    fontFamily: codeFont,
    fontSize: 9,
    fontWeight: "800",
  },
  logStatus: {
    color: Theme.colors.foreground,
    fontFamily: codeFont,
    fontSize: 10,
    fontWeight: "600",
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
    marginTop: 2,
  },
  logFooter: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginTop: 4,
    paddingTop: 4,
    borderTopWidth: 1,
    borderTopColor: "rgba(255,255,255,0.03)",
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
    marginTop: Theme.spacing.xs,
  },
});
