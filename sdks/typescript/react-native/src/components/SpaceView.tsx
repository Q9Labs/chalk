import { resolvePlatformVariant } from "../platform/platform";
import type { Layout } from "../ui/native-types";
import { SpaceViewAndroid } from "./SpaceView.android";
import { SpaceViewIosPad } from "./SpaceView.ios-pad";
import { SpaceViewIosPhone } from "./SpaceView.ios-phone";
import { SpaceViewMacos } from "./SpaceView.macos";
import type { SpaceViewDiagnosticsSnapshot } from "./native-space-view/diagnostics";

export interface SpaceViewFeatures {
  chat?: boolean;
  participants?: boolean;
  admission?: boolean;
  screenShare?: boolean;
  reactions?: boolean;
  handRaise?: boolean;
  whiteboard?: boolean;
  info?: boolean;
  settings?: boolean;
}

export interface SpaceViewProps {
  spaceName?: string;
  inviteLink?: string;
  logoUrl?: string;
  reconnecting?: boolean;
  layout?: Layout;
  onLayoutChange?: (layout: Layout) => void;
  features?: SpaceViewFeatures;
  onLeave: () => void | Promise<void>;
  onEndEpisode?: () => void | Promise<void>;
  onDiagnosticsChange?: (snapshot: SpaceViewDiagnosticsSnapshot) => void;
}

export type { SpaceViewDiagnosticsSnapshot };

export function SpaceView(props: SpaceViewProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <SpaceViewIosPad {...props} />;
    case "ios-phone":
      return <SpaceViewIosPhone {...props} />;
    case "macos":
      return <SpaceViewMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <SpaceViewAndroid {...props} />;
  }
}
