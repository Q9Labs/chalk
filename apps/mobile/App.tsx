import { recordDevDiagnosticsLifecycleEvent, recordDiagnosticsFailure, resolveDevDiagnosticsMode, setDevDiagnosticsConnection, setDevDiagnosticsDevice, setDevDiagnosticsEnvironment } from "@q9labsai/chalk-react-native/diagnostics";
import { getDeviceInfo } from "@q9labsai/chalk-react-native/runtime";
import { useEffect, useMemo, useRef, useState } from "react";
import { Linking, Text } from "react-native";
import { parseSpaceLink, type MobileRoute } from "./src/lib/spaces";
import { getApiBaseURL } from "./src/lib/mobile-config";
import { loadOnboardingState } from "./src/screens/onboarding-store";

// Metro removes this branch before collecting release dependencies.
const DevStates: typeof import("./src/dev-states").DevStates | null = __DEV__ ? require("./src/dev-states").DevStates : null;

export default function App(): React.JSX.Element {
  const apiBaseURL = useMemo(() => getApiBaseURL(), []);
  const diagnosticsMode = useMemo(() => resolveDevDiagnosticsMode({ isDevRuntime: __DEV__, apiBaseURL }), [apiBaseURL]);
  const diagnosticsEnabled = diagnosticsMode.enabled;
  const [route, setRoute] = useState<MobileRoute>({ kind: "home" });
  const [isBooting, setIsBooting] = useState(true);
  const [devStateURL, setDevStateURL] = useState<string | null>(null);
  const defaultDisplayName = useRef<string | null>(null);

  useEffect(() => {
    if (!diagnosticsEnabled) return;
    recordDevDiagnosticsLifecycleEvent("navigation", `App route: ${route.kind}`, route.kind === "space" ? `Space: ${route.space}` : undefined);
    setDevDiagnosticsEnvironment({
      apiBaseURL,
      buildProfile: diagnosticsMode.buildProfile,
      routeKind: route.kind,
      routeSource: route.kind === "space" ? route.source : null,
      routeSpaceId: route.kind === "space" ? route.space : null,
    });
    setDevDiagnosticsDevice(getDeviceInfo());
  }, [apiBaseURL, diagnosticsEnabled, diagnosticsMode.buildProfile, route]);

  useEffect(() => {
    if (route.kind === "home") setDevDiagnosticsConnection(null);
  }, [route.kind]);

  useEffect(() => {
    let mounted = true;
    const openURL = (url: string | null) => {
      if (!url || !mounted) return;
      if (__DEV__ && url.startsWith("chalk://dev/states")) {
        setDevStateURL(url);
        return;
      }
      setDevStateURL(null);
      const nextRoute = parseSpaceLink(url);
      if (nextRoute) setRoute(nextRoute);
    };
    void Linking.getInitialURL()
      .then(openURL)
      .catch((cause: unknown) => {
        if (diagnosticsEnabled) recordDiagnosticsFailure("initial-link", cause instanceof Error ? cause.message : "Could not read the initial link");
      })
      .finally(() => {
        if (mounted) setIsBooting(false);
      });
    const subscription = Linking.addEventListener("url", ({ url }) => openURL(url));
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [diagnosticsEnabled]);

  useEffect(() => {
    let mounted = true;
    void loadOnboardingState()
      .then((state) => {
        if (mounted) defaultDisplayName.current = state.displayName;
      })
      .catch((cause: unknown) => {
        if (diagnosticsEnabled) recordDiagnosticsFailure("load-display-name", cause instanceof Error ? cause.message : "Could not load the stored display name");
      });
    return () => {
      mounted = false;
    };
  }, [diagnosticsEnabled]);

  if (__DEV__ && DevStates && devStateURL) return <DevStates key={devStateURL} url={devStateURL} />;

  return (
    <Text>
      Chalk mobile is being rebuilt — {isBooting ? "booting: " : ""}
      {route.kind}
      {route.kind === "space" ? `: ${route.space}` : ""}
    </Text>
  );
}
