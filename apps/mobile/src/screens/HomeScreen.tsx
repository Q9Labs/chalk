import { resolveNativePlatformVariant } from "@q9labs/chalk-react-native";
import { HomeScreenIosPad } from "./HomeScreen.ios-pad";
import { HomeScreenMacos } from "./HomeScreen.macos";
import { HomeScreenShared, type HomeScreenProps } from "./HomeScreen.shared";

export type { HomeScreenProps } from "./HomeScreen.shared";

export function HomeScreen(props: HomeScreenProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <HomeScreenIosPad {...props} />;
    case "macos":
      return <HomeScreenMacos {...props} />;
    case "ios-phone":
    case "android":
    case "tvos":
    default:
      return <HomeScreenShared {...props} />;
  }
}
