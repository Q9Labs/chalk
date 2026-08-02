import { resolvePlatformVariant } from "../platform/platform";
import { PreJoinScreenAndroid } from "./PreJoinScreen.android";
import { PreJoinScreenIosPad } from "./PreJoinScreen.ios-pad";
import { PreJoinScreenIosPhone } from "./PreJoinScreen.ios-phone";
import { PreJoinScreenMacos } from "./PreJoinScreen.macos";

export type PreJoinSettings = {
  readonly displayName: string;
  readonly microphoneEnabled: boolean;
  readonly cameraEnabled: boolean;
};

export interface PreJoinScreenProps {
  roomName: string;
  role?: "host" | "participant";
  userName?: string;
  initialAudioEnabled?: boolean;
  initialVideoEnabled?: boolean;
  error?: string | null;
  logo?: React.ReactNode;
  joinDisabled?: boolean;
  onJoin: (settings: PreJoinSettings) => void;
  onCancel?: () => void;
}

export function PreJoinScreen(props: PreJoinScreenProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <PreJoinScreenIosPad {...props} />;
    case "ios-phone":
      return <PreJoinScreenIosPhone {...props} />;
    case "macos":
      return <PreJoinScreenMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <PreJoinScreenAndroid {...props} />;
  }
}
