import { wideEvents, type ChalkSession } from "@q9labs/chalk-core";
import { ChalkNativeProvider, NativeVideoConference, useSession, type NativeVideoConferenceDiagnosticsSnapshot } from "@q9labs/chalk-react-native";
import { Bug02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { StatusBar } from "expo-status-bar";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { DevDiagnosticsSheet } from "./src/components/DevDiagnosticsSheet";
import { clearJoinContext, clearStoredHostAuth, getApiUrl, getHostTokenProvider, getJoinAccessToken, getMobileDebugContext, getWsUrl, parseUrlLike, resolveJoinToken, type LobbyRoute, type MobileRoute } from "./src/lib/chalk";
import { classifyTarget, fetchDevDiagnosticsAuth, recordDiagnosticsFailure, recordWideEvent, resetDevDiagnosticsState, setDevDiagnosticsAuthInfo, setDevDiagnosticsEnvironment, setDevDiagnosticsSession, setDevDiagnosticsStaticAuth, setDevDiagnosticsToken } from "./src/lib/dev-diagnostics";
import { Theme } from "./src/lib/theme";
import { HomeScreen } from "./src/screens/HomeScreen";

export default function App(): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const wsUrl = useMemo(() => getWsUrl(apiUrl), [apiUrl]);
  const diagnosticsEnabled = __DEV__ && classifyTarget(apiUrl) === "local";
  const buildProfile = diagnosticsEnabled ? "development" : "production";
  const [route, setRoute] = useState<MobileRoute>({ kind: "home" });
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [isRefreshingDiagnosticsAuth, setIsRefreshingDiagnosticsAuth] = useState(false);
  const diagnosticsSessionRef = useRef<ChalkSession | null>(null);
  const lastJoinErrorRef = useRef<string | null>(null);

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
  }, [apiUrl, diagnosticsEnabled, route]);

  const syncStaticDiagnostics = useCallback(async () => {
    if (!diagnosticsEnabled) {
      return;
    }

    setDevDiagnosticsStaticAuth(await getMobileDebugContext(apiUrl));
  }, [apiUrl, diagnosticsEnabled]);

  const openDiagnosticsForFailure = useCallback(
    (source: string, message: string) => {
      if (!diagnosticsEnabled) {
        return;
      }

      recordDiagnosticsFailure(source, message);
      setDiagnosticsOpen(true);
    },
    [diagnosticsEnabled],
  );

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
        } catch (error) {
          openDiagnosticsForFailure("initial-link-resolve", error instanceof Error ? error.message : "Failed to resolve initial join link");
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
  }, [apiUrl, openDiagnosticsForFailure]);

  useEffect(() => {
    if (!diagnosticsEnabled) {
      wideEvents.configure({ enabled: false, includeDebugInfo: false, handler: undefined });
      setDevDiagnosticsSession(null);
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

    void syncStaticDiagnostics();
  }, [apiUrl, buildProfile, diagnosticsEnabled, route, syncStaticDiagnostics, wsUrl]);

  useEffect(() => {
    if (route.kind !== "lobby") {
      diagnosticsSessionRef.current = null;
      setDevDiagnosticsSession(null);
      lastJoinErrorRef.current = null;
    }
  }, [route.kind]);

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
      void syncStaticDiagnostics();
    }
  }, [apiUrl, diagnosticsEnabled, route, syncStaticDiagnostics, tokenProvider]);

  const handleConferenceDiagnostics = useCallback(
    (snapshot: NativeVideoConferenceDiagnosticsSnapshot) => {
      if (!diagnosticsEnabled) {
        return;
      }

      setDevDiagnosticsSession(snapshot);

      if (snapshot.lastJoinError && snapshot.lastJoinError !== lastJoinErrorRef.current) {
        lastJoinErrorRef.current = snapshot.lastJoinError;
        openDiagnosticsForFailure("native-join", snapshot.lastJoinError);
        return;
      }

      if (!snapshot.lastJoinError) {
        lastJoinErrorRef.current = null;
      }
    },
    [diagnosticsEnabled, openDiagnosticsForFailure],
  );

  const handleConferenceError = useCallback(
    (error: { message: string }) => {
      openDiagnosticsForFailure("conference-error", error.message);
    },
    [openDiagnosticsForFailure],
  );

  const handleForceDisconnect = useCallback(async () => {
    const session = diagnosticsSessionRef.current;
    if (!session) {
      return;
    }

    try {
      await session.leave();
    } catch {
      session.chalkClient.disconnect();
    }
  }, []);

  const handleClearJoinContext = useCallback(async () => {
    await clearJoinContext();
    await syncStaticDiagnostics();
  }, [syncStaticDiagnostics]);

  const handleClearHostAuth = useCallback(async () => {
    await clearStoredHostAuth(apiUrl);
    await syncStaticDiagnostics();
  }, [apiUrl, syncStaticDiagnostics]);

  const handleResetDiagnostics = useCallback(async () => {
    resetDevDiagnosticsState();
    setDevDiagnosticsEnvironment({
      buildProfile,
      apiUrl,
      wsUrl: wsUrl ?? null,
      routeKind: route.kind,
      routeRoomId: route.kind === "lobby" ? route.roomId : null,
      routeSource: route.kind === "lobby" ? route.source : null,
    });
    setDevDiagnosticsSession(null);
    await syncStaticDiagnostics();
  }, [apiUrl, buildProfile, route, syncStaticDiagnostics, wsUrl]);

  return (
    <View style={styles.appShell}>
      <StatusBar style="light" />
      {route.kind === "home" ? <HomeScreen onDiagnosticsFailure={openDiagnosticsForFailure} onNavigate={openLobby} /> : null}
      {route.kind === "lobby" ? (
        <MeetingScreen
          apiUrl={apiUrl}
          diagnosticsEnabled={diagnosticsEnabled}
          onClose={goHome}
          onDiagnosticsChange={handleConferenceDiagnostics}
          onDiagnosticsError={handleConferenceError}
          onSessionChange={(session) => {
            diagnosticsSessionRef.current = session;
          }}
          route={route}
          tokenProvider={tokenProvider}
          wideEvents={diagnosticsWideEvents}
          wsUrl={wsUrl}
        />
      ) : null}
      {diagnosticsEnabled ? (
        <>
          <Pressable hitSlop={16} onPress={() => setDiagnosticsOpen(true)} style={styles.devButton}>
            <HugeiconsIcon color={Theme.colors.primary} icon={Bug02Icon} size={18} />
          </Pressable>
          <DevDiagnosticsSheet
            isRefreshingAuth={isRefreshingDiagnosticsAuth}
            onClearHostAuth={handleClearHostAuth}
            onClearJoinContext={handleClearJoinContext}
            onClose={() => setDiagnosticsOpen(false)}
            onForceDisconnect={handleForceDisconnect}
            onRefreshAuth={refreshDiagnosticsAuth}
            onResetDiagnostics={handleResetDiagnostics}
            visible={diagnosticsOpen}
          />
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
  onDiagnosticsChange,
  onDiagnosticsError,
  onSessionChange,
}: {
  route: LobbyRoute;
  onClose: () => Promise<void>;
  apiUrl: string;
  wsUrl?: string;
  tokenProvider?: () => Promise<string>;
  diagnosticsEnabled: boolean;
  wideEvents?: { enabled?: boolean; includeDebugInfo?: boolean; handler?: typeof recordWideEvent };
  onDiagnosticsChange?: (snapshot: NativeVideoConferenceDiagnosticsSnapshot) => void;
  onDiagnosticsError?: (error: { message: string }) => void;
  onSessionChange?: (session: ChalkSession | null) => void;
}): React.JSX.Element {
  return (
    <ChalkNativeProvider apiUrl={apiUrl} debug={diagnosticsEnabled} tokenProvider={tokenProvider} wideEvents={wideEvents} wsUrl={wsUrl}>
      <MeetingDiagnosticsBridge onSessionChange={onSessionChange} />
      <NativeVideoConference
        autoJoin={false}
        features={{ screenShare: false }}
        initialPhase="lobby"
        onClose={onClose}
        onDiagnosticsChange={onDiagnosticsChange}
        onError={onDiagnosticsError}
        roomId={route.roomId}
        roomName={route.roomName}
        role={route.role}
        userName={route.role === "host" ? "Host" : "Guest"}
      />
    </ChalkNativeProvider>
  );
}

function MeetingDiagnosticsBridge({ onSessionChange }: { onSessionChange?: (session: ChalkSession | null) => void }): null {
  const session = useSession();

  useEffect(() => {
    onSessionChange?.(session);
    return () => {
      onSessionChange?.(null);
    };
  }, [onSessionChange, session]);

  return null;
}

const styles = StyleSheet.create({
  appShell: {
    flex: 1,
  },
  devButton: {
    position: "absolute",
    top: 64,
    right: 16,
    width: 36,
    height: 36,
    borderRadius: Theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(10, 10, 11, 0.95)",
    borderWidth: 1.5,
    borderColor: "rgba(27, 182, 166, 0.35)",
    shadowColor: Theme.colors.primary,
    shadowOpacity: 0.12,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 2 },
    elevation: 4,
  },
});
