import { Platform } from "react-native";
import { HomeScreenIosPad } from "./HomeScreen.ios-pad";
import { HomeScreenMacos } from "./HomeScreen.macos";
import { HomeScreenShared, type HomeScreenProps } from "./HomeScreen.shared";

export type { HomeScreenProps } from "./HomeScreen.shared";

export function HomeScreen(props: HomeScreenProps): React.JSX.Element {
  if (Platform.OS === "macos") return <HomeScreenMacos {...props} />;
  if (Platform.OS === "ios" && Platform.isPad) return <HomeScreenIosPad {...props} />;
  return <HomeScreenShared {...props} />;
}
