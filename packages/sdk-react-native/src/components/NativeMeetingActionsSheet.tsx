import { resolveNativePlatformVariant } from "../platform/native-platform";
import { NativeMeetingActionsSheetAndroid } from "./NativeMeetingActionsSheet.android";
import { NativeMeetingActionsSheetIosPad } from "./NativeMeetingActionsSheet.ios-pad";
import { NativeMeetingActionsSheetIosPhone } from "./NativeMeetingActionsSheet.ios-phone";
import { NativeMeetingActionsSheetMacos } from "./NativeMeetingActionsSheet.macos";
import type { NativeMeetingActionsSheetProps } from "./native-meeting-room/types";

export function NativeMeetingActionsSheet(props: NativeMeetingActionsSheetProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativeMeetingActionsSheetIosPad {...props} />;
    case "ios-phone":
      return <NativeMeetingActionsSheetIosPhone {...props} />;
    case "macos":
      return <NativeMeetingActionsSheetMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativeMeetingActionsSheetAndroid {...props} />;
  }
}
