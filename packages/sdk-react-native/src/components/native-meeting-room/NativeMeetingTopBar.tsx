import { resolveNativePlatformVariant } from "../../platform/native-platform";
import { NativeMeetingTopBarAndroid, type NativeMeetingTopBarProps } from "./NativeMeetingTopBar.android";
import { NativeMeetingTopBarIosPad } from "./NativeMeetingTopBar.ios-pad";
import { NativeMeetingTopBarIosPhone } from "./NativeMeetingTopBar.ios-phone";
import { NativeMeetingTopBarMacos } from "./NativeMeetingTopBar.macos";

export function NativeMeetingTopBar(props: NativeMeetingTopBarProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativeMeetingTopBarIosPad {...props} />;
    case "ios-phone":
      return <NativeMeetingTopBarIosPhone {...props} />;
    case "macos":
      return <NativeMeetingTopBarMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativeMeetingTopBarAndroid {...props} />;
  }
}
