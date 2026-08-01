import { resolvePlatformVariant } from "../platform/platform";
import { JoiningScreenAndroid } from "./JoiningScreen.android";
import { JoiningScreenIosPad } from "./JoiningScreen.ios-pad";
import { JoiningScreenIosPhone } from "./JoiningScreen.ios-phone";
import { JoiningScreenMacos } from "./JoiningScreen.macos";

export interface JoiningScreenProps {
  displayName: string;
  message?: string;
  supportingMessages?: readonly string[];
}

export function JoiningScreen(props: JoiningScreenProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <JoiningScreenIosPad {...props} />;
    case "ios-phone":
      return <JoiningScreenIosPhone {...props} />;
    case "macos":
      return <JoiningScreenMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <JoiningScreenAndroid {...props} />;
  }
}
