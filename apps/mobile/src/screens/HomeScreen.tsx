import { resolvePlatformVariant } from "@q9labsai/chalk-react-native";
import { HomeScreenMacos } from "./HomeScreen.macos";
import { HomeScreenShared, type HomeScreenProps } from "./HomeScreen.shared";

export type { HomeScreenProps } from "./HomeScreen.shared";

export function HomeScreen(props: HomeScreenProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <HomeScreenShared {...props} />;
    case "macos":
      return <HomeScreenMacos {...props} />;
    case "ios-phone":
    case "android":
    case "tvos":
    default:
      return <HomeScreenShared {...props} />;
  }
}
