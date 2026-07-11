import { resolveNativePlatformVariant } from "../../platform/native-platform";
import { NativeMeetingStageAndroid, type NativeMeetingStageProps } from "./NativeMeetingStage.android";
import { NativeMeetingStageIosPad } from "./NativeMeetingStage.ios-pad";
import { NativeMeetingStageIosPhone } from "./NativeMeetingStage.ios-phone";
import { NativeMeetingStageMacos } from "./NativeMeetingStage.macos";

export function NativeMeetingStage(props: NativeMeetingStageProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativeMeetingStageIosPad {...props} />;
    case "ios-phone":
      return <NativeMeetingStageIosPhone {...props} />;
    case "macos":
      return <NativeMeetingStageMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativeMeetingStageAndroid {...props} />;
  }
}
