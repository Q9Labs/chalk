import { resolvePlatformVariant } from "../platform/platform";
import { EntranceViewAndroid } from "./EntranceView.android";
import { EntranceViewIosPad } from "./EntranceView.ios-pad";
import { EntranceViewIosPhone } from "./EntranceView.ios-phone";
import { EntranceViewMacos } from "./EntranceView.macos";

export type EntranceViewSettings = {
  readonly displayName: string;
  readonly microphoneEnabled: boolean;
  readonly cameraEnabled: boolean;
};

export interface EntranceViewProps {
  spaceName: string;
  displayName?: string;
  initialAudioEnabled?: boolean;
  initialVideoEnabled?: boolean;
  error?: string | null;
  logo?: React.ReactNode;
  joinDisabled?: boolean;
  onJoin: (settings: EntranceViewSettings) => void;
  onCancel?: () => void;
}

export function EntranceView(props: EntranceViewProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <EntranceViewIosPad {...props} />;
    case "ios-phone":
      return <EntranceViewIosPhone {...props} />;
    case "macos":
      return <EntranceViewMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <EntranceViewAndroid {...props} />;
  }
}
