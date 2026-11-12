/** A visible, live video whose decoded frame count does not grow for this long has stalled. */
export const VIDEO_DECODE_STALL_MS = 8000;
const MAX_SAMPLE_GAP_MS = 3000;

export type DecodedVideo = {
  readonly publicationId: string;
  readonly trackId: string;
  readonly framesDecoded: number;
};

type Progress = { trackId: string; framesDecoded: number; advancedAt: number; reported: boolean };

/** Decoded frames per received video track, from one `getStats()` report. */
export function decodedFrames(report: RTCStatsReport): ReadonlyMap<string, number> {
  const frames = new Map<string, number>();
  report.forEach((row: { type?: string; kind?: string; trackIdentifier?: unknown; framesDecoded?: unknown }) => {
    if (row.type === "inbound-rtp" && row.kind === "video" && typeof row.trackIdentifier === "string" && typeof row.framesDecoded === "number") frames.set(row.trackIdentifier, row.framesDecoded);
  });
  return frames;
}

/**
 * Packets can keep arriving while the decoder shows nothing, which the packet-based receive stall check cannot see.
 * The caller passes only videos that should be moving: live, on screen, not paused on purpose. One stall is reported once;
 * decoding that resumes arms the next. A gap between samples is no evidence, so it starts over.
 */
export class VideoDecodeStallDetector {
  readonly #progress = new Map<string, Progress>();
  #sampledAt: number | undefined;

  sample(now: number, videos: readonly DecodedVideo[]): readonly { readonly publicationId: string; readonly stalledMs: number }[] {
    if (this.#sampledAt !== undefined && (now - this.#sampledAt > MAX_SAMPLE_GAP_MS || now < this.#sampledAt)) this.#progress.clear();
    this.#sampledAt = now;
    const listed = new Set(videos.map((video) => video.publicationId));
    for (const id of this.#progress.keys()) if (!listed.has(id)) this.#progress.delete(id);
    const stalled: { publicationId: string; stalledMs: number }[] = [];
    for (const video of videos) {
      const known = this.#progress.get(video.publicationId);
      if (!known || known.trackId !== video.trackId || video.framesDecoded !== known.framesDecoded) {
        this.#progress.set(video.publicationId, { trackId: video.trackId, framesDecoded: video.framesDecoded, advancedAt: now, reported: false });
        continue;
      }
      if (!known.reported && now - known.advancedAt >= VIDEO_DECODE_STALL_MS) {
        known.reported = true;
        stalled.push({ publicationId: video.publicationId, stalledMs: now - known.advancedAt });
      }
    }
    return stalled;
  }

  /** How many videos are stalled now: reported and not yet decoding again. */
  get stalledVideos(): number {
    let stalled = 0;
    for (const progress of this.#progress.values()) if (progress.reported) stalled++;
    return stalled;
  }

  clear(): void {
    this.#progress.clear();
    this.#sampledAt = undefined;
  }
}
