import Bug02Icon from "@hugeicons/core-free-icons/dist/esm/Bug02Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { recordDevDiagnosticsLifecycleEvent, recordDiagnosticsFailure, resetDevDiagnosticsState, resolveDevDiagnosticsMode, setDevDiagnosticsConnection, setDevDiagnosticsDevice, setDevDiagnosticsEnvironment } from "@q9labsai/chalk-react-native/diagnostics";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import { StatusBar } from "expo-status-bar";
import { type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppBootstrapScreen } from "./src/components/AppBootstrapScreen";
import { DevDiagnosticsSheet } from "./src/components/DevDiagnosticsSheet";
import { DevSdkPreviewScreen } from "./src/dev-preview";
import { canOpenDevPreviewFromRoute, canShowGlobalDiagnostics } from "./src/dev-preview/policy";
import { DEFAULT_PREVIEW_SEARCH, patchPreviewSearch, type PreviewSearch, type PreviewSearchPatch } from "./src/dev-preview/preview-state";
import { parsePreviewRoute } from "./src/dev-preview/preview-route";
import { getDeviceInfo } from "@q9labsai/chalk-react-native/runtime";
import { clearSpaceContext, parseSpaceLink, type MobileRoute, type SpaceOperationObserver } from "./src/lib/spaces";
import { getApiBaseURL, isMobileTelemetryEnabled } from "./src/lib/mobile-config";
import { MobileSpaceScreen } from "./src/space/MobileSpaceScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { OnboardingScreen } from "./src/screens/OnboardingScreen";
import { loadOnboardingState, resolveOnboardingLaunchSurface } from "./src/screens/onboarding-store";

type AppRoute = MobileRoute | { readonly kind: "sdk-preview"; readonly preview: PreviewSearch };

export default function App(): React.JSX.Element {
  const apiBaseURL = useMemo(() => getApiBaseURL(), []);
  const telemetryEnabled = useMemo(() => isMobileTelemetryEnabled(), []);
  const diagnosticsMode = useMemo(() => resolveDevDiagnosticsMode({ isDevRuntime: __DEV__, apiBaseURL }), [apiBaseURL]);
  const diagnosticsEnabled = diagnosticsMode.enabled;
  const [route, setRoute] = useState<AppRoute>({ kind: "home" });
  const [isBooting, setIsBooting] = useState(true);
  const [onboardingStatus, setOnboardingStatus] = useState<"loading" | "required" | "complete">("loading");
  const [defaultDisplayName, setDefaultDisplayName] = useState<string | null>(null);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const routeRef = useRef<AppRoute>({ kind: "home" });

  const syncStaticDiagnostics = useCallback(() => {
    if (diagnosticsEnabled) setDevDiagnosticsDevice(getDeviceInfo());
  }, [diagnosticsEnabled]);

  const openDiagnosticsForFailure = useCallback(
    (source: string, message: string) => {
      if (!diagnosticsEnabled) return;
      recordDiagnosticsFailure(source, message);
      setDiagnosticsOpen(true);
    },
    [diagnosticsEnabled],
  );
  const recordSpaceOperation = useCallback<SpaceOperationObserver>(
    (operation, state) => {
      if (diagnosticsEnabled) recordDevDiagnosticsLifecycleEvent(`public-invite-${operation}`, `Public invite ${operation}`, state);
    },
    [diagnosticsEnabled],
  );

  useEffect(() => {
    routeRef.current = route;
  }, [route]);

  useEffect(() => {
    if (!diagnosticsEnabled || route.kind === "sdk-preview") return;
    recordDevDiagnosticsLifecycleEvent("navigation", `App route: ${route.kind}`, route.kind === "space" ? `Space: ${route.space}` : undefined);
    setDevDiagnosticsEnvironment({
      apiBaseURL,
      buildProfile: diagnosticsMode.buildProfile,
      routeKind: route.kind,
      routeSource: route.kind === "space" ? route.source : null,
      routeSpaceId: route.kind === "space" ? route.space : null,
    });
    syncStaticDiagnostics();
  }, [apiBaseURL, diagnosticsEnabled, diagnosticsMode.buildProfile, route, syncStaticDiagnostics]);

  useEffect(() => {
    if (route.kind === "home") setDevDiagnosticsConnection(null);
  }, [route.kind]);

  useEffect(() => {
    let mounted = true;
    const openURL = (url: string | null) => {
      if (!url || !mounted) return;
      const nextRoute = parsePreviewRoute(url, { isDevRuntime: __DEV__ }) ?? parseSpaceLink(url);
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

  const goHome = useCallback(async () => {
    if (routeRef.current.kind === "space") await clearSpaceContext(routeRef.current);
    setRoute({ kind: "home" });
  }, []);
  const handleClearSpaceContext = useCallback(async () => {
    if (route.kind === "space") await clearSpaceContext(route);
    syncStaticDiagnostics();
  }, [route, syncStaticDiagnostics]);
  const handleResetDiagnostics = useCallback(async () => {
    resetDevDiagnosticsState();
    if (route.kind === "sdk-preview") {
      syncStaticDiagnostics();
      return;
    }
    setDevDiagnosticsEnvironment({
      apiBaseURL,
      buildProfile: diagnosticsMode.buildProfile,
      routeKind: route.kind,
      routeSource: route.kind === "space" ? route.source : null,
      routeSpaceId: route.kind === "space" ? route.space : null,
    });
    setDevDiagnosticsConnection(null);
    syncStaticDiagnostics();
  }, [apiBaseURL, diagnosticsMode.buildProfile, route, syncStaticDiagnostics]);
  const handlePreviewSearchChange = useCallback((patch: PreviewSearchPatch) => {
    setRoute((current) => (current.kind === "sdk-preview" ? { ...current, preview: patchPreviewSearch(current.preview, patch) } : current));
  }, []);
  const openSdkPreview = useCallback(() => {
    setRoute({ kind: "sdk-preview", preview: DEFAULT_PREVIEW_SEARCH });
  }, []);

  const showDeveloperControls = __DEV__ && onboardingStatus === "complete";

  return (
    <SafeAreaProvider>
      <View style={styles.appShell}>
        <StatusBar backgroundColor={Theme.colors.background} style="dark" />
        {renderContent({
          apiBaseURL,
          defaultDisplayName,
          isBooting,
          onClose: goHome,
          onDiagnosticsConnection: diagnosticsEnabled ? setDevDiagnosticsConnection : undefined,
          onDiagnosticsFailure: openDiagnosticsForFailure,
          onOperation: recordSpaceOperation,
          onNavigate: setRoute,
          onOnboardingComplete: (displayName) => {
            setDefaultDisplayName(displayName || null);
            setOnboardingStatus("complete");
          },
          onPreviewSearchChange: handlePreviewSearchChange,
          route,
          onboardingStatus,
          telemetryEnabled,
        })}
        {showDeveloperControls ? (
          <>
            {route.kind === "home" ? (
              <Pressable accessibilityLabel="Open SDK preview" accessibilityRole="button" hitSlop={16} onPress={openSdkPreview} style={styles.devPreviewButton}>
                <Text style={styles.devPreviewButtonText}>SDK</Text>
              </Pressable>
            ) : null}
            {diagnosticsEnabled && canShowGlobalDiagnostics(route.kind) ? (
              <>
                <Pressable accessibilityLabel="Open diagnostics" accessibilityRole="button" hitSlop={16} onPress={() => setDiagnosticsOpen(true)} style={styles.devButton}>
                  <HugeiconsIcon color={Theme.colors.primary} icon={Bug02Icon} size={18} />
                </Pressable>
                <DevDiagnosticsSheet onClearSpaceContext={handleClearSpaceContext} onClose={() => setDiagnosticsOpen(false)} onResetDiagnostics={handleResetDiagnostics} visible={diagnosticsOpen} />
              </>
            ) : null}
          </>
        ) : null}
      </View>
    </SafeAreaProvider>
  );
}

function renderContent({
  apiBaseURL,
  defaultDisplayName,
  isBooting,
  onClose,
  onDiagnosticsConnection,
  onDiagnosticsFailure,
  onOperation,
  onNavigate,
  onOnboardingComplete,
  onPreviewSearchChange,
  onboardingStatus,
  route,
  telemetryEnabled,
}: {
  readonly apiBaseURL: string;
  readonly defaultDisplayName: string | null;
  readonly isBooting: boolean;
  readonly onClose: () => Promise<void>;
  readonly onDiagnosticsConnection?: (snapshot: Parameters<typeof setDevDiagnosticsConnection>[0]) => void;
  readonly onDiagnosticsFailure: (source: string, message: string) => void;
  readonly onOperation: SpaceOperationObserver;
  readonly onNavigate: (route: AppRoute) => void;
  readonly onOnboardingComplete: (displayName: string) => void;
  readonly onPreviewSearchChange: (patch: PreviewSearchPatch) => void;
  readonly onboardingStatus: "loading" | "required" | "complete";
  readonly route: AppRoute;
  readonly telemetryEnabled: boolean;
}): ReactElement {
  if (isBooting) return <AppBootstrapScreen label="Starting Chalk…" />;
  if (route.kind === "sdk-preview") return <DevSdkPreviewScreen onClose={onClose} onSearchChange={onPreviewSearchChange} search={route.preview} />;
  if (onboardingStatus === "loading") return <AppBootstrapScreen label="Starting Chalk…" />;
  if (onboardingStatus === "required") return <OnboardingScreen onComplete={onOnboardingComplete} />;
  if (route.kind === "home") return <HomeScreen apiBaseURL={apiBaseURL} onError={(message) => onDiagnosticsFailure("public-space-create", message)} onNavigate={onNavigate} onOperation={onOperation} />;
  return (
    <MobileSpaceScreen
      apiBaseURL={apiBaseURL}
      defaultDisplayName={defaultDisplayName}
      onClose={onClose}
      onDiagnosticsConnection={onDiagnosticsConnection}
      onDiagnosticsFailure={(error) => onDiagnosticsFailure("space-error", error.message)}
      onOperation={onOperation}
      route={route}
      telemetryEnabled={telemetryEnabled}
    />
  );
}

const styles = StyleSheet.create({
  appShell: { flex: 1, backgroundColor: Theme.colors.background },
  devPreviewButton: { alignItems: "center", backgroundColor: Theme.colors.card, borderColor: Theme.colors.border, borderRadius: 18, borderWidth: 1, height: 36, justifyContent: "center", minWidth: 36, paddingHorizontal: 8, position: "absolute", right: 16, top: 64 },
  devPreviewButtonText: { color: Theme.colors.primary, fontSize: 11, fontWeight: "800", letterSpacing: 0.5 },
  devButton: { alignItems: "center", backgroundColor: Theme.colors.card, borderColor: Theme.colors.border, borderRadius: 18, borderWidth: 1, height: 36, justifyContent: "center", position: "absolute", right: 16, top: 64, width: 36 },
});
