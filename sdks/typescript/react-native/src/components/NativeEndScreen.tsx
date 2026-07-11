import { resolveNativePlatformVariant } from "../platform/native-platform";
import { NativeEndScreenAndroid } from "./NativeEndScreen.android";
import { NativeEndScreenIosPad } from "./NativeEndScreen.ios-pad";
import { NativeEndScreenIosPhone } from "./NativeEndScreen.ios-phone";
import { NativeEndScreenMacos } from "./NativeEndScreen.macos";

export interface NativeMeetingEndData {
  roomId: string;
  roomName: string;
  durationSeconds: number;
  participantCount: number;
  chatCount: number;
  transcriptCount: number;
}

export interface NativeEndScreenProps {
  data: NativeMeetingEndData;
  onRejoin: () => void;
  onGoHome: () => void;
}

export function NativeEndScreen(props: NativeEndScreenProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativeEndScreenIosPad {...props} />;
    case "ios-phone":
      return <NativeEndScreenIosPhone {...props} />;
    case "macos":
      return <NativeEndScreenMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativeEndScreenAndroid {...props} />;
  }
}
