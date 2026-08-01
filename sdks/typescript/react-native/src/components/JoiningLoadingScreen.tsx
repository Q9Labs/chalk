import { resolvePlatformVariant } from "../platform/platform";
import { JoiningLoadingScreenAndroid } from "./JoiningLoadingScreen.android";
import { JoiningLoadingScreenIosPad } from "./JoiningLoadingScreen.ios-pad";
import { JoiningLoadingScreenIosPhone } from "./JoiningLoadingScreen.ios-phone";
import { JoiningLoadingScreenMacos } from "./JoiningLoadingScreen.macos";

export interface JoiningLoadingScreenProps {
  displayName: string;
  message?: string;
  supportingMessages?: readonly string[];
}

export function JoiningLoadingScreen(props: JoiningLoadingScreenProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <JoiningLoadingScreenIosPad {...props} />;
    case "ios-phone":
      return <JoiningLoadingScreenIosPhone {...props} />;
    case "macos":
      return <JoiningLoadingScreenMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <JoiningLoadingScreenAndroid {...props} />;
  }
}
