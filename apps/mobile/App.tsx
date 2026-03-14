import { StatusBar } from "expo-status-bar";
import { useEffect, useMemo, useState } from "react";
import { Linking } from "react-native";
import { clearJoinContext, getApiUrl, parseUrlLike, resolveJoinToken, type LobbyRoute, type MobileRoute, type RoomRoute } from "./src/lib/chalk";
import { HomeScreen } from "./src/screens/HomeScreen";
import { LobbyScreen } from "./src/screens/LobbyScreen";
import { RoomScreen } from "./src/screens/RoomScreen";

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

  const openRoom = (nextRoute: RoomRoute) => {
    setRoute(nextRoute);
  };

  return (
    <>
      <StatusBar style="light" />
      {route.kind === "home" ? <HomeScreen onNavigate={openLobby} /> : null}
      {route.kind === "lobby" ? <LobbyScreen onBack={() => void goHome()} onJoin={openRoom} route={route} /> : null}
      {route.kind === "room" ? <RoomScreen onBack={() => void goHome()} route={route} /> : null}
    </>
  );
}
