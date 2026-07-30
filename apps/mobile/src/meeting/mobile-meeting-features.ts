import type { NativeMeetingRoomFeatures } from "@q9labsai/chalk-react-native";

export const MOBILE_MEETING_FEATURES: Readonly<NativeMeetingRoomFeatures> = {
  chat: true,
  participants: true,
  transcripts: false,
  settings: true,
  screenShare: true,
  recording: false,
  reactions: true,
  handRaise: true,
  whiteboard: true,
};
