import { resolveNativePlatformVariant } from "../platform/native-platform";
import { NativeMeetingRoomAndroid } from "./NativeMeetingRoom.android";
import { NativeMeetingRoomIosPad } from "./NativeMeetingRoom.ios-pad";
import { NativeMeetingRoomIosPhone } from "./NativeMeetingRoom.ios-phone";
import { NativeMeetingRoomMacos } from "./NativeMeetingRoom.macos";
import type { NativeMeetingRoomDiagnosticsSnapshot } from "./native-meeting-room/diagnostics";

export interface NativeMeetingRoomFeatures {
  chat?: boolean;
  participants?: boolean;
  transcripts?: boolean;
  settings?: boolean;
  screenShare?: boolean;
  recording?: boolean;
  reactions?: boolean;
  handRaise?: boolean;
  whiteboard?: boolean;
}

export interface NativeMeetingRoomProps {
  roomName?: string;
  features?: NativeMeetingRoomFeatures;
  onLeave: () => void | Promise<void>;
  onEndForAll?: () => void | Promise<void>;
  onDiagnosticsChange?: (snapshot: NativeMeetingRoomDiagnosticsSnapshot) => void;
}

export type { NativeMeetingRoomDiagnosticsSnapshot };

export function NativeMeetingRoom(props: NativeMeetingRoomProps): React.JSX.Element {
  switch (resolveNativePlatformVariant()) {
    case "ios-pad":
      return <NativeMeetingRoomIosPad {...props} />;
    case "ios-phone":
      return <NativeMeetingRoomIosPhone {...props} />;
    case "macos":
      return <NativeMeetingRoomMacos {...props} />;
    case "tvos":
    case "android":
    default:
      return <NativeMeetingRoomAndroid {...props} />;
  }
}
