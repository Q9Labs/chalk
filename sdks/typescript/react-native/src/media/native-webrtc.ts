import { MediaStream, RTCView, mediaDevices } from "@cloudflare/react-native-webrtc";
import type { MediaStream as NativeMediaStream, MediaStreamTrack as NativeMediaStreamTrack } from "@cloudflare/react-native-webrtc";

export { MediaStream, RTCView, mediaDevices };
export type { NativeMediaStream, NativeMediaStreamTrack };

export function createNativeMediaStream(track: MediaStreamTrack | NativeMediaStreamTrack): NativeMediaStream {
  const stream = Reflect.construct(MediaStream, [[track]]);
  if (!(stream instanceof MediaStream)) throw new TypeError("React Native WebRTC did not create a media stream");
  return stream;
}
