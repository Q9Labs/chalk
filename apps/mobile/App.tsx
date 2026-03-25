import { wideEvents } from "@q9labs/chalk-core";
import { ChalkNativeProvider, NativeVideoConference } from "@q9labs/chalk-react-native";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Linking, Pressable, StyleSheet, Text, View } from "react-native";
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
  }, [apiUrl, diagnosticsEnabled, route]);

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

  const goHome = async () => {
    await clearJoinContext();
    setRoute({ kind: "home" });
  };

  const openLobby = (nextRoute: LobbyRoute) => {
    setRoute(nextRoute);
  };

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
      {route.kind === "lobby" ? <MeetingScreen apiUrl={apiUrl} onClose={() => void goHome()} route={route} tokenProvider={tokenProvider} wsUrl={wsUrl} diagnosticsEnabled={diagnosticsEnabled} /> : null}
      {diagnosticsEnabled ? (
        <>
          <Pressable onPress={() => setDiagnosticsOpen(true)} style={styles.devPill}>
            <Text style={styles.devPillText}>DEV</Text>
          </Pressable>
          <DevDiagnosticsSheet isRefreshingAuth={isRefreshingDiagnosticsAuth} onClose={() => setDiagnosticsOpen(false)} onRefreshAuth={refreshDiagnosticsAuth} visible={diagnosticsOpen} />
        </>
      ) : null}
    </View>
  );
}

function MeetingScreen({ route, onClose, apiUrl, wsUrl, tokenProvider, diagnosticsEnabled }: { route: LobbyRoute; onClose: () => void; apiUrl: string; wsUrl?: string; tokenProvider?: () => Promise<string>; diagnosticsEnabled: boolean }): React.JSX.Element {
  return (
    <ChalkNativeProvider apiUrl={apiUrl} debug={diagnosticsEnabled} tokenProvider={tokenProvider} wideEvents={diagnosticsEnabled ? { enabled: true, includeDebugInfo: true, handler: recordWideEvent } : undefined} wsUrl={wsUrl}>
      <NativeVideoConference autoJoin={false} features={{ screenShare: false }} initialPhase="lobby" onClose={onClose} roomId={route.roomId} roomName={route.roomName} role={route.role} userName={route.role === "host" ? "Host" : "Guest"} />
    </ChalkNativeProvider>
  );
}

const styles = StyleSheet.create({
  appShell: {
    flex: 1,
  },
  devPill: {
    position: "absolute",
    top: 58,
    right: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 999,
    backgroundColor: "#11c2b4",
    shadowColor: "#11c2b4",
    shadowOpacity: 0.35,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  devPillText: {
    color: "#041110",
    fontSize: 12,
    fontWeight: "900",
    letterSpacing: 1,
  },
});
