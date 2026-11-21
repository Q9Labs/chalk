/**
 * The channel the rendered tile uses to reach the kernel. The media client registers one listener;
 * the web tile reports real probe fields, the native tile reports what it cannot measure as
 * probe_unavailable, and both report the tile's surface state. Before the client registers (or after
 * it goes), reports are no-ops.
 */

export type VideoTileState = "picture" | "avatar" | "paused_for_network" | "frozen_frame" | "media_state";

/** The fields of a video.tile surface row; the kernel adds surface_state and shown_ms. */
export type VideoTileFields = {
  readonly tile_state: VideoTileState;
  readonly status_shown?: boolean;
  readonly tile_reason?: string;
  readonly publication_id?: string;
};

/** The fields of a video.render_probe fact row; unmeasured fields are simply absent. */
export type VideoRenderProbeFields = {
  readonly publication_id?: string;
  readonly local?: boolean;
  readonly presented_frames?: number;
  readonly ready_state?: number;
  readonly video_width?: number;
  readonly video_height?: number;
  readonly rect_w?: number;
  readonly rect_h?: number;
  readonly on_screen?: boolean;
  readonly page_visible?: boolean;
  readonly covered?: boolean;
  readonly luma_mean?: number;
  readonly probe_unavailable?: "native_render";
};

export type VideoTileHandle = { dismiss(): void };

export type VideoObservationListener = {
  /** Open a video.tile surface row; the handle dismisses it. */
  readonly surface: (fields: VideoTileFields) => VideoTileHandle;
  /** Write one video.render_probe row. */
  readonly probe: (fields: VideoRenderProbeFields) => void;
};

let listener: VideoObservationListener | null = null;

/** One per media client; returns the unregister for teardown. */
export function registerVideoObservation(next: VideoObservationListener): () => void {
  listener = next;
  return () => {
    if (listener === next) listener = null;
  };
}

/** Open a "video.tile" surface row; dismiss the returned handle when the state ends. */
export function showVideoTile(fields: VideoTileFields): VideoTileHandle {
  return listener?.surface(fields) ?? { dismiss() {} };
}

/** Write one "video.render_probe" row. */
export function reportVideoRenderProbe(fields: VideoRenderProbeFields): void {
  listener?.probe(fields);
}
