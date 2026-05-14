import { resolveNativePlatformVariant } from "../../platform/native-platform";
import { NativeMeetingBottomDockAndroid } from "./NativeMeetingBottomDock.android";
import { NativeMeetingBottomDockIosPad } from "./NativeMeetingBottomDock.ios-pad";
import { NativeMeetingBottomDockIosPhone } from "./NativeMeetingBottomDock.ios-phone";
import { NativeMeetingBottomDockMacos } from "./NativeMeetingBottomDock.macos";
import type { NativeMeetingBottomDockProps } from "./types";

export function NativeMeetingBottomDock(props: NativeMeetingBottomDockProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativeMeetingBottomDockIosPad {...props} />;
    case "ios-phone":
      return <NativeMeetingBottomDockIosPhone {...props} />;
    case "macos":
      return <NativeMeetingBottomDockMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativeMeetingBottomDockAndroid {...props} />;
  }
}
