export type VideoRenderSize = { readonly width: number; readonly height: number };
const sizes = new WeakMap<MediaStreamTrack, VideoRenderSize>();

/** Tells the media client how large the UI draws a remote video, in device pixels. Pass null when the track leaves the screen. */
export function setVideoRenderSize(track: MediaStreamTrack, size: VideoRenderSize | null): void {
  if (size === null) sizes.delete(track);
  else sizes.set(track, size);
}

export function videoRenderSize(track: MediaStreamTrack): VideoRenderSize | undefined {
  return sizes.get(track);
}
