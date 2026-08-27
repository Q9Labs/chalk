import { useEffect, useRef, useState, type RefObject } from "react";

import { observeFirstRenderedFrame } from "../../internal/episode-diagnostic-render-observer";

/**
 * - `idle`: nothing attached (no track, disabled, or track not live)
 * - `loading`: attached, waiting for the first decoded frame
 * - `playing`: frames are rendering
 * - `muted`: track attached but the source is not producing frames (remote paused / network)
 * - `ended`: the track ended while attached
 * - `error`: playback was refused by the browser
 */
export type VideoTrackStatus = "idle" | "loading" | "playing" | "muted" | "ended" | "error";

/**
 * Attaches a MediaStreamTrack to a video element and reports whether frames are actually rendering.
 * Detaches (clears srcObject) on change or unmount so tiles never show a frozen last frame.
 */
export function useVideoTrack(videoRef: RefObject<HTMLVideoElement | null>, track: MediaStreamTrack | null | undefined, enabled: boolean): VideoTrackStatus {
  const [status, setStatus] = useState<VideoTrackStatus>("idle");
  const loadedRef = useRef(false);

  useEffect(() => {
    const video = videoRef.current;
    loadedRef.current = false;
    if (!video || !track || !enabled || track.readyState !== "live") {
      if (video) video.srcObject = null;
      setStatus("idle");
      return;
    }

    video.srcObject = new MediaStream([track]);
    setStatus(track.muted ? "muted" : "loading");

    const onLoaded = () => {
      loadedRef.current = true;
      setStatus(track.readyState !== "live" ? "ended" : track.muted ? "muted" : "playing");
      observeFirstRenderedFrame(video, track);
    };
    const onMute = () => setStatus("muted");
    const onUnmute = () => setStatus(loadedRef.current ? "playing" : "loading");
    const onEnded = () => setStatus("ended");

    video.addEventListener("loadeddata", onLoaded);
    track.addEventListener("mute", onMute);
    track.addEventListener("unmute", onUnmute);
    track.addEventListener("ended", onEnded);

    video.play().catch((cause: unknown) => {
      // AbortError: attach superseded by a newer track before playback began — the newer effect owns the element.
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setStatus("error");
    });

    return () => {
      video.removeEventListener("loadeddata", onLoaded);
      track.removeEventListener("mute", onMute);
      track.removeEventListener("unmute", onUnmute);
      track.removeEventListener("ended", onEnded);
      video.srcObject = null;
    };
  }, [enabled, track, videoRef]);

  return status;
}
