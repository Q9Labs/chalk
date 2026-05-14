import { resolveNativePlatformVariant } from "../../platform/native-platform";
import { NativeMeetingGridAndroid, type NativeMeetingGridProps } from "./NativeMeetingGrid.android";
import { NativeMeetingGridIosPad } from "./NativeMeetingGrid.ios-pad";
import { NativeMeetingGridIosPhone } from "./NativeMeetingGrid.ios-phone";
import { NativeMeetingGridMacos } from "./NativeMeetingGrid.macos";

export function NativeMeetingGrid(props: NativeMeetingGridProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativeMeetingGridIosPad {...props} />;
    case "ios-phone":
      return <NativeMeetingGridIosPhone {...props} />;
    case "macos":
      return <NativeMeetingGridMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativeMeetingGridAndroid {...props} />;
  }
}
