import { wideEvents, type ChalkSession } from "@q9labs/chalk-core";
import type { NativeVideoConferenceDiagnosticsSnapshot } from "@q9labs/chalk-react-native";
import { Bug02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react-native";
import { StatusBar } from "expo-status-bar";
import { type ComponentType, type ReactElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Linking, Pressable, StyleSheet, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AppBootstrapScreen } from "./src/components/AppBootstrapScreen";
import { DevDiagnosticsSheet } from "./src/components/DevDiagnosticsSheet";
import { clearJoinContext, clearStoredHostAuth, getApiUrl, getHostTokenProvider, getJoinAccessToken, getMobileDebugContext, getWsUrl, parseUrlLike, resolveJoinToken, type LobbyRoute, type MobileRoute } from "./src/lib/chalk";
import {
  fetchDevDiagnosticsAuth,
  recordDevDiagnosticsLifecycleEvent,
  recordDiagnosticsFailure,
  recordWideEvent,
  resetDevDiagnosticsState,
  resolveDevDiagnosticsMode,
  setDevDiagnosticsAuthInfo,
  setDevDiagnosticsEnvironment,
  setDevDiagnosticsSession,
  setDevDiagnosticsStaticAuth,
  setDevDiagnosticsToken,
} from "./src/lib/dev-diagnostics";
import { Theme } from "./src/lib/theme";
import type { MeetingScreenProps } from "./src/meeting/MobileMeetingScreen";
import { HomeScreen } from "./src/screens/HomeScreen";

type LazyMeetingScreenComponent = ComponentType<MeetingScreenProps>;

export default function App(): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const wsUrl = useMemo(() => getWsUrl(apiUrl), [apiUrl]);
  const diagnosticsMode = useMemo(() => resolveDevDiagnosticsMode({ isDevRuntime: __DEV__, apiUrl }), [apiUrl]);
  const diagnosticsEnabled = diagnosticsMode.enabled;
  const buildProfile = diagnosticsMode.buildProfile;
  const [route, setRoute] = useState<MobileRoute>({ kind: "home" });
  const [isBooting, setIsBooting] = useState(true);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [isRefreshingDiagnosticsAuth, setIsRefreshingDiagnosticsAuth] = useState(false);
  const [MeetingScreen, setMeetingScreen] = useState<LazyMeetingScreenComponent | null>(null);
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
        if (diagnosticsEnabled) {
          recordDevDiagnosticsLifecycleEvent("auth", "Requesting join access token", joinToken);
        }
        const token = await getJoinAccessToken(apiUrl, joinToken);
        if (diagnosticsEnabled) {
          setDevDiagnosticsToken(token, "join-token");
          recordDevDiagnosticsLifecycleEvent("auth", "Join access token received");
        }
        return token;
      };
    }

    const hostTokenProvider = getHostTokenProvider(apiUrl);
    if (!hostTokenProvider) {
      return undefined;
    }

    return async () => {
      if (diagnosticsEnabled) {
        recordDevDiagnosticsLifecycleEvent("auth", "Requesting host token");
      }
      const token = await hostTokenProvider();
      if (diagnosticsEnabled) {
        setDevDiagnosticsToken(token, "host");
        recordDevDiagnosticsLifecycleEvent("auth", "Host token received");
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
    if (!diagnosticsEnabled) return;
    recordDevDiagnosticsLifecycleEvent("navigation", `App route: ${route.kind}`, route.kind === "lobby" ? `Room: ${route.roomId}` : undefined);
  }, [route, diagnosticsEnabled]);

  useEffect(() => {
    let isMounted = true;

    const openUrl = async (url: string | null) => {
      if (!url) {
        return;
      }

      if (diagnosticsEnabled) {
        recordDevDiagnosticsLifecycleEvent("navigation", "Deep link received", url);
      }

      const nextRoute = parseUrlLike(url);
      if (!nextRoute) {
        return;
      }

      if (nextRoute.joinToken) {
        try {
          if (diagnosticsEnabled) {
            recordDevDiagnosticsLifecycleEvent("navigation", "Resolving join token", nextRoute.joinToken);
          }
          const resolvedRoute = await resolveJoinToken(nextRoute.joinToken, apiUrl);
          if (!isMounted) {
            return;
          }
          setRoute(resolvedRoute);
        } catch (error) {
          if (!isMounted) {
            return;
          }
          openDiagnosticsForFailure("initial-link-resolve", error instanceof Error ? error.message : "Failed to resolve initial join link");
          setRoute({ kind: "home" });
        }
        return;
      }

      if (isMounted) {
        setRoute(nextRoute);
      }
    };

    const initialize = async () => {
      try {
        await openUrl(await Linking.getInitialURL());
      } finally {
        if (isMounted) {
          setIsBooting(false);
        }
      }
    };

    void initialize();
    const subscription = Linking.addEventListener("url", ({ url }) => {
      void openUrl(url);
    });

    return () => {
      isMounted = false;
      subscription.remove();
    };
  }, [apiUrl, openDiagnosticsForFailure]);

  useEffect(() => {
    if (route.kind !== "lobby" || MeetingScreen) {
      return;
    }

    let isMounted = true;

    void import("./src/meeting/MobileMeetingScreen").then((module) => {
      if (!isMounted) {
        return;
      }
      setMeetingScreen(() => module.MobileMeetingScreen);
    });

    return () => {
      isMounted = false;
    };
  }, [MeetingScreen, route.kind]);

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

  const handleSessionChange = useCallback((session: ChalkSession | null) => {
    diagnosticsSessionRef.current = session;
  }, []);

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
    <SafeAreaProvider>
      <View style={styles.appShell}>
        <StatusBar style="light" />
        {renderContent({
          MeetingScreen,
          apiUrl,
          diagnosticsEnabled,
          handleConferenceDiagnostics,
          handleConferenceError,
          isBooting,
          onClose: goHome,
          onDiagnosticsFailure: openDiagnosticsForFailure,
          onNavigate: openLobby,
          onSessionChange: handleSessionChange,
          route,
          tokenProvider,
          wideEvents: diagnosticsWideEvents,
          wsUrl,
        })}
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
    </SafeAreaProvider>
  );
}

function renderContent({
  MeetingScreen,
  apiUrl,
  diagnosticsEnabled,
  handleConferenceDiagnostics,
  handleConferenceError,
  isBooting,
  onClose,
  onDiagnosticsFailure,
  onNavigate,
  onSessionChange,
  route,
  tokenProvider,
  wideEvents,
  wsUrl,
}: {
  MeetingScreen: LazyMeetingScreenComponent | null;
  apiUrl: string;
  diagnosticsEnabled: boolean;
  handleConferenceDiagnostics: (snapshot: NativeVideoConferenceDiagnosticsSnapshot) => void;
  handleConferenceError: (error: { message: string }) => void;
  isBooting: boolean;
  onClose: () => Promise<void>;
  onDiagnosticsFailure: (source: string, message: string) => void;
  onNavigate: (route: LobbyRoute) => void;
  onSessionChange: (session: ChalkSession | null) => void;
  route: MobileRoute;
  tokenProvider?: () => Promise<string>;
  wideEvents?: { enabled?: boolean; includeDebugInfo?: boolean; handler?: typeof recordWideEvent };
  wsUrl?: string;
}): ReactElement {
  if (isBooting) {
    return <AppBootstrapScreen label="Starting Chalk..." />;
  }

  if (route.kind === "home") {
    return <HomeScreen onDiagnosticsFailure={onDiagnosticsFailure} onNavigate={onNavigate} />;
  }

  if (!MeetingScreen) {
    return <AppBootstrapScreen label="Preparing meeting..." />;
  }

  return (
    <MeetingScreen
      apiUrl={apiUrl}
      diagnosticsEnabled={diagnosticsEnabled}
      onClose={onClose}
      onDiagnosticsChange={handleConferenceDiagnostics}
      onDiagnosticsError={handleConferenceError}
      onSessionChange={onSessionChange}
      route={route}
      tokenProvider={tokenProvider}
      wideEvents={wideEvents}
      wsUrl={wsUrl}
    />
  );
}

const styles = StyleSheet.create({
  appShell: {
    flex: 1,
    backgroundColor: Theme.colors.background,
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
