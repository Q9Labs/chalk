import { wideEvents } from "@q9labs/chalk-core";
import { ChalkNativeProvider, NativeVideoConference } from "@q9labs/chalk-react-native";
import { Bug02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { DevDiagnosticsSheet } from "./src/components/DevDiagnosticsSheet";
import { fetchDevDiagnosticsAuth, recordWideEvent, setDevDiagnosticsAuthInfo, setDevDiagnosticsEnvironment, setDevDiagnosticsStaticAuth, setDevDiagnosticsToken } from "./src/lib/dev-diagnostics";
import { clearJoinContext, getApiUrl, getHostTokenProvider, getJoinAccessToken, getMobileDebugContext, getWsUrl, type LobbyRoute, type MobileRoute, parseUrlLike, resolveJoinToken } from "./src/lib/chalk";
import { HomeScreen } from "./src/screens/HomeScreen";

export default function App(): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const wsUrl = useMemo(() => getWsUrl(apiUrl), [apiUrl]);
  const diagnosticsEnabled = __DEV__;
  const buildProfile = diagnosticsEnabled ? "development" : "production";
  const [route, setRoute] = useState<MobileRoute>({ kind: "home" });
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [isRefreshingDiagnosticsAuth, setIsRefreshingDiagnosticsAuth] = useState(false);
  const diagnosticsWideEvents = useMemo(() => (diagnosticsEnabled ? { enabled: true, includeDebugInfo: true, handler: recordWideEvent } : undefined), [diagnosticsEnabled]);

  const tokenProvider = useMemo(() => {
    if (route.kind !== "lobby") {
      return undefined;
    }

    if (route.joinToken) {
      const joinToken = route.joinToken;
      return async () => {
        const token = await getJoinAccessToken(apiUrl, joinToken);
        if (diagnosticsEnabled) {
          setDevDiagnosticsToken(token, "join-token");
        }
        return token;
      };
    }

    const hostTokenProvider = getHostTokenProvider(apiUrl);
    if (!hostTokenProvider) {
      return undefined;
    }

    return async () => {
      const token = await hostTokenProvider();
      if (diagnosticsEnabled) {
        setDevDiagnosticsToken(token, "host");
      }
      return token;
    };
  }, [apiUrl, diagnosticsEnabled, route.kind, route.kind === "lobby" ? route.joinToken : null]);

  useEffect(() => {
    const openUrl = async (url: string | null) => {
      if (!url) {
        return;
      }

      const nextRoute = parseUrlLike(url);
      if (!nextRoute) {
        return;
      }

      if (nextRoute.joinToken) {
        try {
          setRoute(await resolveJoinToken(nextRoute.joinToken, apiUrl));
        } catch {
          setRoute({ kind: "home" });
        }
        return;
      }

      setRoute(nextRoute);
    };

    void Linking.getInitialURL().then(openUrl);
    const subscription = Linking.addEventListener("url", ({ url }) => {
      void openUrl(url);
    });

    return () => {
      subscription.remove();
    };
  }, [apiUrl]);

  useEffect(() => {
    if (!diagnosticsEnabled) {
      return;
    }

    wideEvents.configure({
      enabled: true,
      includeDebugInfo: true,
      handler: recordWideEvent,
    });
  }, [diagnosticsEnabled]);

  useEffect(() => {
    if (!diagnosticsEnabled) {
      return;
    }

    setDevDiagnosticsEnvironment({
      buildProfile,
      apiUrl,
      wsUrl: wsUrl ?? null,
      routeKind: route.kind,
      routeRoomId: route.kind === "lobby" ? route.roomId : null,
      routeSource: route.kind === "lobby" ? route.source : null,
    });

    void getMobileDebugContext(apiUrl).then(setDevDiagnosticsStaticAuth);
  }, [apiUrl, buildProfile, diagnosticsEnabled, route, wsUrl]);

  const goHome = useCallback(async () => {
    await clearJoinContext();
    setRoute({ kind: "home" });
  }, []);

  const openLobby = useCallback((nextRoute: LobbyRoute) => {
    setRoute(nextRoute);
  }, []);

  const refreshDiagnosticsAuth = useCallback(async () => {
    if (!diagnosticsEnabled || route.kind !== "lobby" || !tokenProvider) {
      return;
    }

    setIsRefreshingDiagnosticsAuth(true);
    try {
      const token = await tokenProvider();
      const authInfo = await fetchDevDiagnosticsAuth(apiUrl, token);
      setDevDiagnosticsAuthInfo(authInfo);
      setDevDiagnosticsToken(token, route.joinToken ? "join-token" : "host");
      setDevDiagnosticsEnvironment({
        routeRoomId: authInfo.roomId ?? route.roomId,
      });
    } catch {
      setDevDiagnosticsAuthInfo(null);
    } finally {
      setIsRefreshingDiagnosticsAuth(false);
      void getMobileDebugContext(apiUrl).then(setDevDiagnosticsStaticAuth);
    }
  }, [apiUrl, diagnosticsEnabled, route, tokenProvider]);

  return (
    <View style={styles.appShell}>
      <StatusBar style="light" />
      {route.kind === "home" ? <HomeScreen onNavigate={openLobby} /> : null}
      {route.kind === "lobby" ? <MeetingScreen apiUrl={apiUrl} diagnosticsEnabled={diagnosticsEnabled} onClose={goHome} route={route} tokenProvider={tokenProvider} wideEvents={diagnosticsWideEvents} wsUrl={wsUrl} /> : null}
      {diagnosticsEnabled ? (
        <>
          <Pressable hitSlop={8} onPress={() => setDiagnosticsOpen(true)} style={styles.devButton}>
            <HugeiconsIcon color="#11c2b4" icon={Bug02Icon} size={18} />
          </Pressable>
          <DevDiagnosticsSheet isRefreshingAuth={isRefreshingDiagnosticsAuth} onClose={() => setDiagnosticsOpen(false)} onRefreshAuth={refreshDiagnosticsAuth} visible={diagnosticsOpen} />
        </>
      ) : null}
    </View>
  );
}

function MeetingScreen({
  route,
  onClose,
  apiUrl,
  wsUrl,
  tokenProvider,
  diagnosticsEnabled,
  wideEvents,
}: {
  route: LobbyRoute;
  onClose: () => Promise<void>;
  apiUrl: string;
  wsUrl?: string;
  tokenProvider?: () => Promise<string>;
  diagnosticsEnabled: boolean;
  wideEvents?: { enabled?: boolean; includeDebugInfo?: boolean; handler?: typeof recordWideEvent };
}): React.JSX.Element {
  return (
    <ChalkNativeProvider apiUrl={apiUrl} debug={diagnosticsEnabled} tokenProvider={tokenProvider} wideEvents={wideEvents} wsUrl={wsUrl}>
      <NativeVideoConference autoJoin={false} features={{ screenShare: false }} initialPhase="lobby" onClose={onClose} roomId={route.roomId} roomName={route.roomName} role={route.role} userName={route.role === "host" ? "Host" : "Guest"} />
    </ChalkNativeProvider>
  );
}

const styles = StyleSheet.create({
  appShell: {
    flex: 1,
  },
  devButton: {
    position: "absolute",
    top: 58,
    right: 16,
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(11, 18, 21, 0.92)",
    borderWidth: 1,
    borderColor: "rgba(17, 194, 180, 0.28)",
    shadowColor: "#11c2b4",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
});
