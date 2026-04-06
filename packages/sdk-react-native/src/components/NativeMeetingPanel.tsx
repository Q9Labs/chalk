import { resolveNativePlatformVariant } from "../platform/native-platform";
import { NativeMeetingPanelAndroid, type NativeMeetingPanelProps } from "./NativeMeetingPanel.android";
import { NativeMeetingPanelIosPad } from "./NativeMeetingPanel.ios-pad";
import { NativeMeetingPanelIosPhone } from "./NativeMeetingPanel.ios-phone";
import { NativeMeetingPanelMacos } from "./NativeMeetingPanel.macos";
export type { NativeMeetingPanelName } from "./native-meeting-room/types";

export function NativeMeetingPanel(props: NativeMeetingPanelProps): React.JSX.Element | null {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativeMeetingPanelIosPad {...props} />;
    case "ios-phone":
      return <NativeMeetingPanelIosPhone {...props} />;
    case "macos":
      return <NativeMeetingPanelMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativeMeetingPanelAndroid {...props} />;
  }
}
