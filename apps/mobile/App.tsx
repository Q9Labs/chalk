import type { ChalkSessionStore } from "@q9labsai/chalk-client";
import type { VideoConferenceDiagnosticsSnapshot as SpaceDiagnosticsSnapshot } from "@q9labsai/chalk-react-native";
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
import { DevSdkPreviewScreen } from "./src/dev-preview";
import { canOpenDevPreviewFromRoute, canShowGlobalDiagnostics } from "./src/dev-preview/policy";
import { DEFAULT_PREVIEW_SEARCH, patchPreviewSearch, type PreviewSearchPatch } from "./src/dev-preview/preview-state";
import { clearJoinContext, getBrokerUrl, getMobileDebugContext, parseMobileRoute, type LobbyRoute, type MobileRoute } from "./src/lib/chalk";
import { MobileMeetingScreen } from "./src/meeting/MobileMeetingScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { OnboardingScreen } from "./src/screens/OnboardingScreen";
import { loadOnboardingState, resolveOnboardingLaunchSurface } from "./src/screens/onboarding-store";

const ROUTE_FIELD = { spaceId: "roomId" } as const;

export default function App(): React.JSX.Element {
  const brokerUrl = useMemo(() => getBrokerUrl(), []);
  const diagnosticsMode = useMemo(() => resolveDevDiagnosticsMode({ isDevRuntime: __DEV__, brokerUrl }), [brokerUrl]);
  const diagnosticsEnabled = diagnosticsMode.enabled;
  const [route, setRoute] = useState<MobileRoute>({ kind: "home" });
  const [isBooting, setIsBooting] = useState(true);
  const [onboardingStatus, setOnboardingStatus] = useState<"loading" | "required" | "complete">("loading");
  const [defaultDisplayName, setDefaultDisplayName] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const routeRef = useRef<MobileRoute>({ kind: "home" });
  const diagnosticsSessionRef = useRef<ChalkSessionStore | null>(null);
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
    if (!diagnosticsEnabled || route.kind === "sdk-preview") return;
    recordDevDiagnosticsLifecycleEvent("navigation", `App route: ${route.kind}`, route.kind === "lobby" ? `Space route: ${route[ROUTE_FIELD.spaceId]}` : undefined);
  }, [diagnosticsEnabled, route]);

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    let mounted = true;
    const openURL = (url: string | null) => {
      if (!url || !mounted) return;
      const nextRoute = parseMobileRoute(url, { isDevRuntime: __DEV__ });
      if (!nextRoute) return;
      if (nextRoute.kind === "sdk-preview" && !canOpenDevPreviewFromRoute(routeRef.current.kind)) return;
      setRoute(nextRoute);
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
    let mounted = true;
    void loadOnboardingState()
      .then((state) => {
        if (!mounted) return;
        setDefaultDisplayName(state.displayName);
        setOnboardingStatus(resolveOnboardingLaunchSurface(state) === "home" ? "complete" : "required");
      })
      .catch(() => {
        if (mounted) setOnboardingStatus("required");
      });
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!diagnosticsEnabled || route.kind === "sdk-preview") return;
    setDevDiagnosticsEnvironment({
      buildProfile: diagnosticsMode.buildProfile,
      brokerUrl,
      routeKind: route.kind,
      routeRoomId: route.kind === "lobby" ? route[ROUTE_FIELD.spaceId] : null,
      routeSource: route.kind === "lobby" ? route.source : null,
    });
    void syncStaticDiagnostics();
  }, [brokerUrl, diagnosticsEnabled, diagnosticsMode.buildProfile, route, syncStaticDiagnostics]);

  useEffect(() => {
    if (route.kind === "lobby" || route.kind === "sdk-preview") return;
    diagnosticsSessionRef.current = null;
    lastJoinErrorRef.current = null;
    setDevDiagnosticsSession(null);
  }, [route.kind]);

  const goHome = useCallback(async () => {
    await clearJoinContext();
    setRoute({ kind: "home" });
  }, []);

  const handleConferenceDiagnostics = useCallback(
    (snapshot: SpaceDiagnosticsSnapshot) => {
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
    if (route.kind === "sdk-preview") {
      await syncStaticDiagnostics();
      return;
    }
    setDevDiagnosticsEnvironment({
      buildProfile: diagnosticsMode.buildProfile,
      brokerUrl,
      routeKind: route.kind,
      routeRoomId: route.kind === "lobby" ? route[ROUTE_FIELD.spaceId] : null,
      routeSource: route.kind === "lobby" ? route.source : null,
    });
    await syncStaticDiagnostics();
  }, [brokerUrl, diagnosticsMode.buildProfile, route, syncStaticDiagnostics]);

  const handlePreviewSearchChange = useCallback((patch: PreviewSearchPatch) => {
    setRoute((current) => (current.kind === "sdk-preview" ? { ...current, preview: patchPreviewSearch(current.preview, patch) } : current));
  }, []);

  const openSdkPreview = useCallback(() => {
    setRoute({ kind: "sdk-preview", preview: DEFAULT_PREVIEW_SEARCH });
  }, []);

  const showDeveloperControls = __DEV__ && onboardingStatus === "complete";
  const showSdkPreviewLauncher = showDeveloperControls && route.kind === "home";
  const showDiagnosticsControls = showDeveloperControls && diagnosticsEnabled && canShowGlobalDiagnostics(route.kind);

  return (
    <SafeAreaProvider>
      <View style={styles.appShell}>
        <StatusBar backgroundColor={Theme.colors.background} style="dark" />
        {renderContent({
          brokerUrl,
          defaultDisplayName,
          handleConferenceDiagnostics,
          isBooting,
          onboardingStatus,
          onClose: goHome,
          onDiagnosticsFailure: openDiagnosticsForFailure,
          onNavigate: setRoute,
          onOnboardingComplete: (displayName) => {
            setDefaultDisplayName(displayName || null);
            setOnboardingStatus("complete");
          },
          onPreviewSearchChange: handlePreviewSearchChange,
          onSessionChange: (session) => {
            diagnosticsSessionRef.current = session;
          },
          route,
        })}
        {showDeveloperControls ? (
          <>
            {showSdkPreviewLauncher ? (
              <Pressable accessibilityLabel="Open SDK preview" accessibilityRole="button" hitSlop={16} onPress={openSdkPreview} style={styles.devPreviewButton}>
                <Text style={styles.devPreviewButtonText}>SDK</Text>
              </Pressable>
            ) : null}
            {showDiagnosticsControls ? (
              <>
                <Pressable accessibilityLabel="Open diagnostics" accessibilityRole="button" hitSlop={16} onPress={() => setDiagnosticsOpen(true)} style={styles.devButton}>
                  <HugeiconsIcon color={Theme.colors.primary} icon={Bug02Icon} size={18} />
                </Pressable>
                <DevDiagnosticsSheet onClearClientSession={handleClearClientSession} onClose={() => setDiagnosticsOpen(false)} onForceDisconnect={handleForceDisconnect} onResetDiagnostics={handleResetDiagnostics} visible={diagnosticsOpen} />
              </>
            ) : null}
          </>
        ) : null}
      </View>
    </SafeAreaProvider>
  );
}

function renderContent({
  brokerUrl,
  defaultDisplayName,
  handleConferenceDiagnostics,
  isBooting,
  onboardingStatus,
  onClose,
  onDiagnosticsFailure,
  onNavigate,
  onOnboardingComplete,
  onPreviewSearchChange,
  onSessionChange,
  route,
}: {
  readonly brokerUrl: string;
  readonly defaultDisplayName: string | null;
  readonly handleConferenceDiagnostics: (snapshot: SpaceDiagnosticsSnapshot) => void;
  readonly isBooting: boolean;
  readonly onboardingStatus: "loading" | "required" | "complete";
  readonly onClose: () => Promise<void>;
  readonly onDiagnosticsFailure: (source: string, message: string) => void;
  readonly onNavigate: (route: LobbyRoute) => void;
  readonly onOnboardingComplete: (displayName: string) => void;
  readonly onPreviewSearchChange: (patch: PreviewSearchPatch) => void;
  readonly onSessionChange: (session: ChalkSessionStore | null) => void;
  readonly route: MobileRoute;
}): ReactElement {
  if (isBooting) return <AppBootstrapScreen label="Starting Chalk…" />;
  if (route.kind === "sdk-preview") return <DevSdkPreviewScreen onClose={onClose} onSearchChange={onPreviewSearchChange} search={route.preview} />;
  if (onboardingStatus === "loading") return <AppBootstrapScreen label="Starting Chalk…" />;
  if (onboardingStatus === "required") return <OnboardingScreen onComplete={onOnboardingComplete} />;
  if (route.kind === "home") {
    return <HomeScreen onDiagnosticsFailure={onDiagnosticsFailure} onNavigate={onNavigate} />;
  }
  return <MobileMeetingScreen brokerUrl={brokerUrl} defaultDisplayName={defaultDisplayName} onClose={onClose} onDiagnosticsChange={handleConferenceDiagnostics} onDiagnosticsError={(error) => onDiagnosticsFailure("space-error", error.message)} onSessionChange={onSessionChange} route={route} />;
}

const styles = StyleSheet.create({
  appShell: { flex: 1, backgroundColor: Theme.colors.background },
  devPreviewButton: {
    position: "absolute",
    top: 64,
    right: 64,
    minWidth: 36,
    height: 36,
    paddingHorizontal: 8,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: Theme.colors.card,
    borderWidth: 1,
    borderColor: Theme.colors.border,
  },
  devPreviewButtonText: { color: Theme.colors.primary, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
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
});
