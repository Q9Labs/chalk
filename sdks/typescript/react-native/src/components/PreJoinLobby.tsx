import { resolvePlatformVariant } from "../platform/platform";
import { PreJoinLobbyAndroid } from "./PreJoinLobby.android";
import { PreJoinLobbyIosPad } from "./PreJoinLobby.ios-pad";
import { PreJoinLobbyIosPhone } from "./PreJoinLobby.ios-phone";
import { PreJoinLobbyMacos } from "./PreJoinLobby.macos";

export type PreJoinSettings = {
  readonly displayName: string;
  readonly microphoneEnabled: boolean;
  readonly cameraEnabled: boolean;
};

export interface PreJoinLobbyProps {
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

export function PreJoinLobby(props: PreJoinLobbyProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <PreJoinLobbyIosPad {...props} />;
    case "ios-phone":
      return <PreJoinLobbyIosPhone {...props} />;
    case "macos":
      return <PreJoinLobbyMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <PreJoinLobbyAndroid {...props} />;
  }
}
