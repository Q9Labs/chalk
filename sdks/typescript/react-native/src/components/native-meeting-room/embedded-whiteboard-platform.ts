import type { NativeMeetingRoomFeatures } from "../NativeMeetingRoom";

/** macOS does not bundle the native embedded renderer, so its meeting controls must fail closed. */
export function withoutEmbeddedWhiteboard(features: NativeMeetingRoomFeatures | undefined): NativeMeetingRoomFeatures {
  return {
    ...features,
    whiteboard: false,
  };
}
