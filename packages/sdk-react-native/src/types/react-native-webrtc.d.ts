declare module "@cloudflare/react-native-webrtc" {
  import type { ComponentType } from "react";
  import type { ViewProps } from "react-native";

  export class MediaStream {
    constructor(tracks?: MediaStreamTrack[]);
    toURL(): string;
  }

  export const RTCView: ComponentType<
    ViewProps & {
      streamURL: string;
      mirror?: boolean;
      objectFit?: "cover" | "contain";
    }
  >;
}
