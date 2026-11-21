import { reportVideoRenderProbe, showVideoTile, type VideoTileState } from "@q9labsai/chalk-client";
import { useEffect, useRef, type RefObject } from "react";
import type { VideoTrackStatus } from "./useVideoTrack";

/** A rendered-tile reading every this long while a video element is mounted. */
const PROBE_MS = 2000;
/** A tile this close to the viewport counts as on screen, matching useVideoTileVisibility. */
const EARLY_PULL_MARGIN = "50%";

type ProbeOptions = {
  readonly publicationId?: string;
  readonly local?: boolean;
};

function lumaMean(video: HTMLVideoElement): number | undefined {
  try {
    if (video.videoWidth === 0 || video.videoHeight === 0) return undefined;
    const canvas = document.createElement("canvas");
    canvas.width = 8;
    canvas.height = 8;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return undefined;
    context.drawImage(video, 0, 0, 8, 8);
    const data = context.getImageData(0, 0, 8, 8).data;
    let sum = 0;
    for (let index = 0; index < data.length; index += 4) sum += data[index] * 0.299 + data[index + 1] * 0.587 + data[index + 2] * 0.114;
    return Math.round(sum / (data.length / 4));
  } catch {
    return undefined; // A tainted or detached frame reports no luma rather than a guess.
  }
}

function coveredAtCenter(element: HTMLElement): boolean | undefined {
  try {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return undefined;
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    return top !== null && top !== element && !element.contains(top);
  } catch {
    return undefined;
  }
}

/**
 * Reports the tile's "video.render_probe" rows while the video element is mounted and opens a
 * "video.tile" surface row for the tile's current rendered state. Fields the platform cannot supply
 * stay absent; nothing is guessed.
 */
export function useVideoRenderProbe(
  videoRef: RefObject<HTMLVideoElement | null>,
  track: MediaStreamTrack | null | undefined,
  status: VideoTrackStatus,
  options: ProbeOptions & { readonly state: VideoTileState; readonly statusShown: boolean },
): void {
  const stateRef = useRef(options.state);
  stateRef.current = options.state;

  // The probe rows: frame counters, geometry and occlusion while the element exists.
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Interval- and observer-driven reads of the mounted video element; cleared on change or unmount.
  useEffect(() => {
    const video = videoRef.current;
    if (!video || typeof document === "undefined") return;
    let intersecting = true;
    const intersection =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver(([entry]) => (intersecting = entry?.isIntersecting !== false), { rootMargin: EARLY_PULL_MARGIN });
    intersection?.observe(video);
    const report = () => {
      const rect = video.getBoundingClientRect();
      const quality = video.getVideoPlaybackQuality?.();
      reportVideoRenderProbe({
        ...(options.publicationId ? { publication_id: options.publicationId } : {}),
        ...(options.local !== undefined ? { local: options.local } : {}),
        ...(quality ? { presented_frames: quality.totalVideoFrames } : {}),
        ready_state: video.readyState,
        video_width: video.videoWidth,
        video_height: video.videoHeight,
        rect_w: Math.round(rect.width),
        rect_h: Math.round(rect.height),
        on_screen: intersecting,
        page_visible: document.visibilityState !== "hidden",
        ...(coveredAtCenter(video) !== undefined ? { covered: coveredAtCenter(video) } : {}),
        ...(lumaMean(video) !== undefined ? { luma_mean: lumaMean(video) } : {}),
      });
    };
    report();
    const timer = globalThis.setInterval(report, PROBE_MS);
    return () => {
      globalThis.clearInterval(timer);
      intersection?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- options fields are read fresh each interval via closure capture of the latest render's values.
  }, [videoRef, track]);

  // The surface row: one open "video.tile" per rendered state, dismissed when the state ends.
  const surfaceKey = `${options.state}|${options.statusShown}|${status}|${options.publicationId ?? ""}`;
  // ast-grep-ignore: chalk.forbid-sdk-use-effect-ts -- [resource] Open and dismiss the surface row that mirrors the tile's rendered state.
  useEffect(() => {
    const [tileState, shown, reason] = surfaceKey.split("|");
    const handle = showVideoTile({
      tile_state: tileState as VideoTileState,
      status_shown: shown === "true" ? true : undefined,
      tile_reason: reason || undefined,
      ...(options.publicationId ? { publication_id: options.publicationId } : {}),
    });
    return () => handle.dismiss();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- surfaceKey carries every input.
  }, [surfaceKey]);
}
