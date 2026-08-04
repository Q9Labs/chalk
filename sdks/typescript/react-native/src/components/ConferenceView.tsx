import { resolvePlatformVariant } from "../platform/platform";
import type { ChalkChatAttachment, ChalkSessionStore } from "../client-compat";
import { ConferenceViewAndroid } from "./ConferenceView.android";
import { ConferenceViewIosPad } from "./ConferenceView.ios-pad";
import { ConferenceViewIosPhone } from "./ConferenceView.ios-phone";
import { ConferenceViewMacos } from "./ConferenceView.macos";
import type { ConferenceViewDiagnosticsSnapshot } from "./native-meeting-room/diagnostics";

export interface ConferenceViewFeatures {
  chat?: boolean;
  participants?: boolean;
  screenShare?: boolean;
  reactions?: boolean;
  handRaise?: boolean;
  whiteboard?: boolean;
}

export interface ConferenceViewProps {
  roomName?: string;
  meetingLink?: string;
  features?: ConferenceViewFeatures;
  pickChatAttachments?: (chatFiles: NonNullable<ChalkSessionStore["chatFiles"]>) => Promise<readonly ChalkChatAttachment[]>;
  onLeave: () => void | Promise<void>;
  onEndForAll?: () => void | Promise<void>;
  onDiagnosticsChange?: (snapshot: ConferenceViewDiagnosticsSnapshot) => void;
}

export type { ConferenceViewDiagnosticsSnapshot };

export function ConferenceView(props: ConferenceViewProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <ConferenceViewIosPad {...props} />;
    case "ios-phone":
      return <ConferenceViewIosPhone {...props} />;
    case "macos":
      return <ConferenceViewMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <ConferenceViewAndroid {...props} />;
  }
}
