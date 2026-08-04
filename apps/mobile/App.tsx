import { recordDevDiagnosticsLifecycleEvent, recordDiagnosticsFailure, resetDevDiagnosticsState, resolveDevDiagnosticsMode, setDevDiagnosticsConnection, setDevDiagnosticsDevice, setDevDiagnosticsEnvironment } from "@q9labsai/chalk-react-native/diagnostics";
import { Theme } from "@q9labsai/chalk-react-native/theme";
import Bug02Icon from "@hugeicons/core-free-icons/dist/esm/Bug02Icon";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { StatusBar } from "expo-status-bar";
import { type ReactElement, useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { AppBootstrapScreen } from "./src/components/AppBootstrapScreen";
import { DevDiagnosticsSheet } from "./src/components/DevDiagnosticsSheet";
import { clearSpaceContext, getBrokerUrl, getMobileDeviceContext, isMobileTelemetryEnabled, parseSpaceLink, type MobileRoute, type SpaceRoute } from "./src/lib/spaces";
import { MobileSpaceScreen } from "./src/space/MobileSpaceScreen";
import { HomeScreen } from "./src/screens/HomeScreen";

export default function App(): React.JSX.Element {
  const brokerUrl = useMemo(() => getBrokerUrl(), []);
  const telemetryEnabled = useMemo(() => isMobileTelemetryEnabled(), []);
  const diagnosticsMode = useMemo(() => resolveDevDiagnosticsMode({ isDevRuntime: __DEV__, brokerUrl }), [brokerUrl]);
  const diagnosticsEnabled = diagnosticsMode.enabled;
  const [route, setRoute] = useState<MobileRoute>({ kind: "home" });
  const [isBooting, setIsBooting] = useState(true);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);

  const syncStaticDiagnostics = useCallback(() => {
    if (diagnosticsEnabled) setDevDiagnosticsDevice(getMobileDeviceContext().device);
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
    recordDevDiagnosticsLifecycleEvent("navigation", `App route: ${route.kind}`, route.kind === "space" ? `Space: ${route.space}` : undefined);
  }, [diagnosticsEnabled, route]);

  useEffect(() => {
    let mounted = true;
    const openURL = (url: string | null) => {
      if (!url || !mounted) return;
      const nextRoute = parseSpaceLink(url);
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
      routeSource: route.kind === "space" ? route.source : null,
      routeSpaceId: route.kind === "space" ? route.space : null,
    });
    syncStaticDiagnostics();
  }, [brokerUrl, diagnosticsEnabled, diagnosticsMode.buildProfile, route, syncStaticDiagnostics]);

  useEffect(() => {
    if (route.kind !== "home") return;
    setDevDiagnosticsConnection(null);
  }, [route.kind]);

  const goHome = useCallback(async () => {
    await clearSpaceContext();
    setRoute({ kind: "home" });
  }, []);

  const handleClearSpaceContext = useCallback(async () => {
    await clearSpaceContext();
    syncStaticDiagnostics();
  }, [syncStaticDiagnostics]);

  const handleResetDiagnostics = useCallback(async () => {
    resetDevDiagnosticsState();
    setDevDiagnosticsEnvironment({
      buildProfile: diagnosticsMode.buildProfile,
      brokerUrl,
      routeKind: route.kind,
      routeSource: route.kind === "space" ? route.source : null,
      routeSpaceId: route.kind === "space" ? route.space : null,
    });
    setDevDiagnosticsConnection(null);
    syncStaticDiagnostics();
  }, [brokerUrl, diagnosticsMode.buildProfile, route, syncStaticDiagnostics]);

  return (
    <SafeAreaProvider>
      <View style={styles.appShell}>
        <StatusBar style="light" />
        {renderContent({
          brokerUrl,
          isBooting,
          onClose: goHome,
          onDiagnosticsFailure: openDiagnosticsForFailure,
          onNavigate: setRoute,
          route,
          telemetryEnabled,
        })}
        {diagnosticsEnabled ? (
          <>
            <Pressable hitSlop={16} onPress={() => setDiagnosticsOpen(true)} style={styles.devButton}>
              <HugeiconsIcon color={Theme.colors.primary} icon={Bug02Icon} size={18} />
            </Pressable>
            <DevDiagnosticsSheet onClearSpaceContext={handleClearSpaceContext} onClose={() => setDiagnosticsOpen(false)} onResetDiagnostics={handleResetDiagnostics} visible={diagnosticsOpen} />
          </>
        ) : null}
      </View>
    </SafeAreaProvider>
  );
}

function renderContent({
  brokerUrl,
  isBooting,
  onClose,
  onDiagnosticsFailure,
  onNavigate,
  route,
  telemetryEnabled,
}: {
  readonly brokerUrl: string;
  readonly isBooting: boolean;
  readonly onClose: () => Promise<void>;
  readonly onDiagnosticsFailure: (source: string, message: string) => void;
  readonly onNavigate: (route: SpaceRoute) => void;
  readonly route: MobileRoute;
  readonly telemetryEnabled: boolean;
}): ReactElement {
  if (isBooting) return <AppBootstrapScreen label="Starting Chalk..." />;
  if (route.kind === "home") return <HomeScreen onDiagnosticsFailure={onDiagnosticsFailure} onNavigate={onNavigate} />;

  return <MobileSpaceScreen brokerUrl={brokerUrl} onClose={onClose} onDiagnosticsFailure={(error) => onDiagnosticsFailure("space-error", error.message)} route={route} telemetryEnabled={telemetryEnabled} />;
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
});
