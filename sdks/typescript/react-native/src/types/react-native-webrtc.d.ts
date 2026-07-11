declare module "@cloudflare/react-native-webrtc" {
  import type { ComponentType } from "react";
  import type { ViewProps } from "react-native";

  export interface MediaStreamTrack {
    id: string;
    kind: "audio" | "video";
    enabled: boolean;
    muted: boolean;
    readyState: "live" | "ended";
    stop: () => void;
  }

  export class MediaStream {
    constructor(tracks?: MediaStreamTrack[]);
    toURL(): string;
    getTracks(): MediaStreamTrack[];
    getVideoTracks(): MediaStreamTrack[];
    getAudioTracks(): MediaStreamTrack[];
  }

  export const RTCView: ComponentType<
    ViewProps & {
      streamURL: string;
      mirror?: boolean;
      objectFit?: "cover" | "contain";
      zOrder?: number;
    }
  >;

  export const mediaDevices: {
    getUserMedia: (constraints: unknown) => Promise<MediaStream>;
  };
}
