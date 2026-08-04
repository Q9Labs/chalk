import type { SpaceClient } from "@q9labsai/chalk-client";
import type { VideoConferenceDiagnosticsSnapshot } from "@q9labsai/chalk-react-native";
import { recordDevDiagnosticsLifecycleEvent, recordDiagnosticsFailure, resetDevDiagnosticsState, resolveDevDiagnosticsMode, setDevDiagnosticsClientSession, setDevDiagnosticsEnvironment, setDevDiagnosticsSession } from "@q9labsai/chalk-react-native/diagnostics";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import Bug02Icon from "@hugeicons/core-free-icons/dist/esm/Bug02Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { StatusBar } from "expo-status-bar";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppBootstrapScreen } from "./src/components/AppBootstrapScreen";
import { DevDiagnosticsSheet } from "./src/components/DevDiagnosticsSheet";
import { clearJoinContext, getBrokerUrl, getMobileDebugContext, parseUrlLike, type LobbyRoute, type MobileRoute } from "./src/lib/chalk";
import { MobileMeetingScreen } from "./src/meeting/MobileMeetingScreen";
import { MobileWhiteboardPlayground } from "./src/meeting/MobileWhiteboardPlayground";
import { shouldShowWhiteboardRendererPlayground } from "./src/meeting/mobile-whiteboard-playground-policy";
import { HomeScreen } from "./src/screens/HomeScreen";

type ConnectedSpaceClient = Pick<SpaceClient, "leave">;

export default function App(): React.JSX.Element {
  const brokerUrl = useMemo(() => getBrokerUrl(), []);
  const diagnosticsMode = useMemo(() => resolveDevDiagnosticsMode({ isDevRuntime: __DEV__, brokerUrl }), [brokerUrl]);
  const diagnosticsEnabled = diagnosticsMode.enabled;
  const [route, setRoute] = useState<MobileRoute>({ kind: "home" });
  const [isBooting, setIsBooting] = useState(true);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [whiteboardPlaygroundOpen, setWhiteboardPlaygroundOpen] = useState(false);
  const diagnosticsSessionRef = useRef<ConnectedSpaceClient | null>(null);
  const lastJoinErrorRef = useRef<string | null>(null);

  const syncStaticDiagnostics = useCallback(async () => {
    if (diagnosticsEnabled) setDevDiagnosticsClientSession(await getMobileDebugContext());
  }, [diagnosticsEnabled]);

  const openDiagnosticsForFailure = useCallback(
    (source: string, message: string) => {
      if (!diagnosticsEnabled) return;
      recordDiagnosticsFailure(source, message);
      setDiagnosticsOpen(true);
    },
    [diagnosticsEnabled],
  );

  useEffect(() => {
    if (!diagnosticsEnabled) return;
    recordDevDiagnosticsLifecycleEvent("navigation", `App route: ${route.kind}`, route.kind === "lobby" ? `Meeting: ${route.roomId}` : undefined);
  }, [diagnosticsEnabled, route]);

  useEffect(() => {
    let mounted = true;
    const openURL = (url: string | null) => {
      if (!url || !mounted) return;
      const nextRoute = parseUrlLike(url);
      if (nextRoute) setRoute(nextRoute);
    };
    void Linking.getInitialURL()
      .then(openURL)
      .finally(() => {
        if (mounted) setIsBooting(false);
      });
    const subscription = Linking.addEventListener("url", ({ url }) => openURL(url));
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    if (!diagnosticsEnabled) return;
    setDevDiagnosticsEnvironment({
      buildProfile: diagnosticsMode.buildProfile,
      brokerUrl,
      routeKind: route.kind,
      routeRoomId: route.kind === "lobby" ? route.roomId : null,
      routeSource: route.kind === "lobby" ? route.source : null,
    });
    void syncStaticDiagnostics();
  }, [brokerUrl, diagnosticsEnabled, diagnosticsMode.buildProfile, route, syncStaticDiagnostics]);

  useEffect(() => {
    if (route.kind === "lobby") return;
    diagnosticsSessionRef.current = null;
    lastJoinErrorRef.current = null;
    setDevDiagnosticsSession(null);
  }, [route.kind]);

  const goHome = useCallback(async () => {
    await clearJoinContext();
    setRoute({ kind: "home" });
  }, []);

  const handleConferenceDiagnostics = useCallback(
    (snapshot: VideoConferenceDiagnosticsSnapshot) => {
      if (!diagnosticsEnabled) return;
      setDevDiagnosticsSession(snapshot);
      if (snapshot.lastJoinError && snapshot.lastJoinError !== lastJoinErrorRef.current) {
        lastJoinErrorRef.current = snapshot.lastJoinError;
        openDiagnosticsForFailure("native-join", snapshot.lastJoinError);
      } else if (!snapshot.lastJoinError) {
        lastJoinErrorRef.current = null;
      }
    },
    [diagnosticsEnabled, openDiagnosticsForFailure],
  );

  const handleForceDisconnect = useCallback(async () => {
    await diagnosticsSessionRef.current?.leave().catch(() => undefined);
  }, []);

  const handleClearClientSession = useCallback(async () => {
    await clearJoinContext();
    await syncStaticDiagnostics();
  }, [syncStaticDiagnostics]);

  const handleResetDiagnostics = useCallback(async () => {
    resetDevDiagnosticsState();
    setDevDiagnosticsEnvironment({
      buildProfile: diagnosticsMode.buildProfile,
      brokerUrl,
      routeKind: route.kind,
      routeRoomId: route.kind === "lobby" ? route.roomId : null,
      routeSource: route.kind === "lobby" ? route.source : null,
    });
    await syncStaticDiagnostics();
  }, [brokerUrl, diagnosticsMode.buildProfile, route, syncStaticDiagnostics]);

  const showWhiteboardPlaygroundEntry = shouldShowWhiteboardRendererPlayground({
    isDevRuntime: __DEV__,
    routeKind: route.kind,
  });

  return (
    <SafeAreaProvider>
      <View style={styles.appShell}>
        <StatusBar style="light" />
        {whiteboardPlaygroundOpen ? (
          <MobileWhiteboardPlayground onClose={() => setWhiteboardPlaygroundOpen(false)} />
        ) : (
          renderContent({
            brokerUrl,
            handleConferenceDiagnostics,
            isBooting,
            onClose: goHome,
            onDiagnosticsFailure: openDiagnosticsForFailure,
            onNavigate: setRoute,
            onSessionChange: (session) => {
              diagnosticsSessionRef.current = session;
            },
            route,
          })
        )}
        {showWhiteboardPlaygroundEntry && !whiteboardPlaygroundOpen ? (
          <Pressable accessibilityRole="button" onPress={() => setWhiteboardPlaygroundOpen(true)} style={({ pressed }) => [styles.whiteboardPlaygroundButton, pressed && styles.whiteboardPlaygroundButtonPressed]}>
            <Text style={styles.whiteboardPlaygroundButtonText}>Whiteboard renderer playground (local only)</Text>
          </Pressable>
        ) : null}
        {diagnosticsEnabled ? (
          <>
            <Pressable hitSlop={16} onPress={() => setDiagnosticsOpen(true)} style={styles.devButton}>
              <HugeiconsIcon color={Theme.colors.primary} icon={Bug02Icon} size={18} />
            </Pressable>
            <DevDiagnosticsSheet onClearClientSession={handleClearClientSession} onClose={() => setDiagnosticsOpen(false)} onForceDisconnect={handleForceDisconnect} onResetDiagnostics={handleResetDiagnostics} visible={diagnosticsOpen} />
          </>
        ) : null}
      </View>
    </SafeAreaProvider>
  );
}

function renderContent({
  brokerUrl,
  handleConferenceDiagnostics,
  isBooting,
  onClose,
  onDiagnosticsFailure,
  onNavigate,
  onSessionChange,
  route,
}: {
  readonly brokerUrl: string;
  readonly handleConferenceDiagnostics: (snapshot: VideoConferenceDiagnosticsSnapshot) => void;
  readonly isBooting: boolean;
  readonly onClose: () => Promise<void>;
  readonly onDiagnosticsFailure: (source: string, message: string) => void;
  readonly onNavigate: (route: LobbyRoute) => void;
  readonly onSessionChange: (session: ConnectedSpaceClient | null) => void;
  readonly route: MobileRoute;
}): ReactElement {
  if (isBooting) return <AppBootstrapScreen label="Starting Chalk..." />;
  if (route.kind === "home") {
    return <HomeScreen onDiagnosticsFailure={onDiagnosticsFailure} onNavigate={onNavigate} />;
  }
  return <MobileMeetingScreen brokerUrl={brokerUrl} onClose={onClose} onDiagnosticsChange={handleConferenceDiagnostics} onDiagnosticsError={(error) => onDiagnosticsFailure("conference-error", error.message)} onSessionChange={onSessionChange} route={route} />;
}

const styles = StyleSheet.create({
  appShell: { flex: 1, backgroundColor: Theme.colors.background },
  devButton: {
    position: "absolute",
    top: 64,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.card,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  whiteboardPlaygroundButton: {
    position: "absolute",
    left: 16,
    bottom: 24,
    borderRadius: Theme.radius.full,
    backgroundColor: Theme.colors.card,
    borderWidth: 1,
    borderColor: Theme.colors.border,
    paddingHorizontal: Theme.spacing.md,
    paddingVertical: Theme.spacing.sm,
  },
  whiteboardPlaygroundButtonPressed: { opacity: 0.72 },
  whiteboardPlaygroundButtonText: { ...Theme.typography.meta, color: Theme.colors.foreground },
});
