import { resolvePlatformVariant } from "../platform/platform";
import { EndScreenAndroid } from "./EndScreen.android";
import { EndScreenIosPad } from "./EndScreen.ios-pad";
import { EndScreenIosPhone } from "./EndScreen.ios-phone";
import { EndScreenMacos } from "./EndScreen.macos";

export interface MeetingEndData {
  roomId: string;
  roomName: string;
  durationSeconds: number;
  participantCount: number;
  chatCount: number;
}

export interface EndScreenProps {
  data: MeetingEndData;
  onRejoin: () => void;
  onGoHome: () => void;
}

export function EndScreen(props: EndScreenProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <EndScreenIosPad {...props} />;
    case "ios-phone":
      return <EndScreenIosPhone {...props} />;
    case "macos":
      return <EndScreenMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <EndScreenAndroid {...props} />;
  }
}
