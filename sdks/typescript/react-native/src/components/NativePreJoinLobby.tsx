import { resolveNativePlatformVariant } from "../platform/native-platform";
import { NativePreJoinLobbyAndroid } from "./NativePreJoinLobby.android";
import { NativePreJoinLobbyIosPad } from "./NativePreJoinLobby.ios-pad";
import { NativePreJoinLobbyIosPhone } from "./NativePreJoinLobby.ios-phone";
import { NativePreJoinLobbyMacos } from "./NativePreJoinLobby.macos";

export interface NativeJoinSettings {
  displayName: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
}

export interface NativePreJoinLobbyProps {
  roomName: string;
  role?: "host" | "participant";
  userName?: string;
  initialAudioEnabled?: boolean;
  initialVideoEnabled?: boolean;
  error?: string | null;
  logo?: React.ReactNode;
  joinDisabled?: boolean;
  onJoin: (settings: NativeJoinSettings) => void;
  onCancel?: () => void;
}

export function NativePreJoinLobby(props: NativePreJoinLobbyProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativePreJoinLobbyIosPad {...props} />;
    case "ios-phone":
      return <NativePreJoinLobbyIosPhone {...props} />;
    case "macos":
      return <NativePreJoinLobbyMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativePreJoinLobbyAndroid {...props} />;
  }
}
