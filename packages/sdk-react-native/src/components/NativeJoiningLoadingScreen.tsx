import { resolveNativePlatformVariant } from "../platform/native-platform";
import { NativeJoiningLoadingScreenAndroid } from "./NativeJoiningLoadingScreen.android";
import { NativeJoiningLoadingScreenIosPad } from "./NativeJoiningLoadingScreen.ios-pad";
import { NativeJoiningLoadingScreenIosPhone } from "./NativeJoiningLoadingScreen.ios-phone";
import { NativeJoiningLoadingScreenMacos } from "./NativeJoiningLoadingScreen.macos";

export interface NativeJoiningLoadingScreenProps {
  displayName: string;
  message?: string;
  supportingMessages?: readonly string[];
}

export function NativeJoiningLoadingScreen(props: NativeJoiningLoadingScreenProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativeJoiningLoadingScreenIosPad {...props} />;
    case "ios-phone":
      return <NativeJoiningLoadingScreenIosPhone {...props} />;
    case "macos":
      return <NativeJoiningLoadingScreenMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativeJoiningLoadingScreenAndroid {...props} />;
  }
}
