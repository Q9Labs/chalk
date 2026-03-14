import { ChalkNativeProvider, NativeVideoConference } from "@q9labs/chalk-react-native";
import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { Linking } from "react-native";
import { clearJoinContext, getApiUrl, getHostTokenProvider, getJoinAccessToken, getWsUrl, parseUrlLike, resolveJoinToken, type LobbyRoute, type MobileRoute } from "./src/lib/chalk";
import { HomeScreen } from "./src/screens/HomeScreen";

export default function App(): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const [route, setRoute] = useState<MobileRoute>({ kind: "home" });

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

  const goHome = async () => {
    await clearJoinContext();
    setRoute({ kind: "home" });
  };

  const openLobby = (nextRoute: LobbyRoute) => {
    setRoute(nextRoute);
  };

  return (
    <>
      <StatusBar style="light" />
      {route.kind === "home" ? <HomeScreen onNavigate={openLobby} /> : null}
      {route.kind === "lobby" ? <MeetingScreen key={`${route.roomId}:${route.joinToken ?? route.source}`} onClose={() => void goHome()} route={route} /> : null}
    </>
  );
}

function MeetingScreen({
  route,
  onClose,
}: {
  route: LobbyRoute;
  onClose: () => void;
}): React.JSX.Element {
  const apiUrl = useMemo(() => getApiUrl(), []);
  const wsUrl = useMemo(() => getWsUrl(apiUrl), [apiUrl]);
  const tokenProvider = useMemo(() => {
    if (route.joinToken) {
      const joinToken = route.joinToken;
      return async () => getJoinAccessToken(apiUrl, joinToken);
    }

    return getHostTokenProvider(apiUrl) ?? undefined;
  }, [apiUrl, route.joinToken]);

  return (
    <ChalkNativeProvider apiUrl={apiUrl} debug tokenProvider={tokenProvider} wsUrl={wsUrl}>
      <NativeVideoConference
        autoJoin={false}
        initialPhase="lobby"
        onClose={onClose}
        roomId={route.roomId}
        roomName={route.roomName}
        role={route.role}
        userName={route.role === "host" ? "Host" : "Guest"}
      />
    </ChalkNativeProvider>
  );
}
