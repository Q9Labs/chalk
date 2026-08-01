import { resolvePlatformVariant } from "../platform/platform";
import type { ChalkChatAttachment, ChalkSessionStore } from "@q9labsai/chalk-client";
import { MeetingRoomAndroid } from "./MeetingRoom.android";
import { MeetingRoomIosPad } from "./MeetingRoom.ios-pad";
import { MeetingRoomIosPhone } from "./MeetingRoom.ios-phone";
import { MeetingRoomMacos } from "./MeetingRoom.macos";
import type { MeetingRoomDiagnosticsSnapshot } from "./native-meeting-room/diagnostics";

export interface MeetingRoomFeatures {
  chat?: boolean;
  participants?: boolean;
  screenShare?: boolean;
  reactions?: boolean;
  handRaise?: boolean;
  whiteboard?: boolean;
}

export interface MeetingRoomProps {
  roomName?: string;
  meetingLink?: string;
  features?: MeetingRoomFeatures;
  pickChatAttachments?: (chatFiles: NonNullable<ChalkSessionStore["chatFiles"]>) => Promise<readonly ChalkChatAttachment[]>;
  onLeave: () => void | Promise<void>;
  onEndForAll?: () => void | Promise<void>;
  onDiagnosticsChange?: (snapshot: MeetingRoomDiagnosticsSnapshot) => void;
}

export type { MeetingRoomDiagnosticsSnapshot };

export function MeetingRoom(props: MeetingRoomProps): React.JSX.Element {
  switch (resolvePlatformVariant()) {
    case "ios-pad":
      return <MeetingRoomIosPad {...props} />;
    case "ios-phone":
      return <MeetingRoomIosPhone {...props} />;
    case "macos":
      return <MeetingRoomMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <MeetingRoomAndroid {...props} />;
  }
}
