import type { VideoPlacement, VideoSegment } from "./scene.js";

export type ComposeEncoder = "libx264" | "h264_videotoolbox" | "h264_nvenc";

export interface ComposeOutput {
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly encoder: ComposeEncoder;
  /** FFmpeg thread cap for every run; undefined lets FFmpeg use every core. */
  readonly threads?: number;
}

export interface PlannedSource {
  readonly path: string;
  readonly startMs: number;
}

const COMMON_ARGS = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error"];

function encoderArgs(encoder: ComposeEncoder): readonly string[] {
  // ultrafast measured SSIM 0.998 against medium at 2 Mb/s for about a third of
  // its CPU; the cost is roughly 14% larger files.
  if (encoder === "libx264") return ["-c:v", "libx264", "-preset", "ultrafast", "-profile:v", "high"];
  if (encoder === "h264_nvenc") return ["-c:v", "h264_nvenc", "-preset", "p4", "-profile:v", "high"];
  return ["-c:v", "h264_videotoolbox", "-allow_sw", "0", "-realtime", "0", "-profile:v", "high"];
}

// FFmpeg reads -threads per input and per output, so the cap has to be set on
// every decoder, the filter graph, and the encoder. Decoders and filters stay
// single-threaded under a cap: Episode-sized inputs gain little from threads.
function inputThreadArgs(output: ComposeOutput): readonly string[] {
  return output.threads === undefined ? [] : ["-threads", "1"];
}

function outputThreadArgs(output: ComposeOutput): readonly string[] {
  return output.threads === undefined ? [] : ["-filter_complex_threads", "1", "-threads", String(output.threads)];
}

function seconds(value: number): string {
  return value.toFixed(6);
}

/**
 * Seconds of video decoded only to reach segment starts: each segment's input
 * seek decodes forward from the nearest earlier keyframe. Keyframes are sorted.
 */
export function seekDecodeSeconds(keyframes: readonly number[], starts: readonly number[]): number {
  let total = 0;
  for (const start of starts) {
    let previous = 0;
    for (const keyframe of keyframes) {
      if (keyframe > start) break;
      previous = keyframe;
    }
    total += start - previous;
  }
  return total;
}

/**
 * Re-encoding a track costs about four decodes of it (camera minute: x264
 * ultrafast 3.5 CPU-s against 0.9 CPU-s to decode), so it pays once the
 * segments' seeks would decode more than that.
 */
export function needsDenseKeyframes(keyframes: readonly number[], starts: readonly number[], durationSeconds: number): boolean {
  return seekDecodeSeconds(keyframes, starts) > 4 * durationSeconds;
}

/** ffprobe arguments that print one line per keyframe time; only keyframes are decoded. */
export function keyframeProbeArgs(path: string): readonly string[] {
  return ["-v", "error", "-select_streams", "v:0", "-skip_frame", "nokey", "-show_entries", "frame=pts_time", "-of", "csv=p=0", path];
}

/** Re-encodes a track with a keyframe every 30 frames, keeping its timestamps, so each segment seek decodes at most about a second. */
export function denseKeyframeArgs(inputPath: string, outputPath: string, output: ComposeOutput): readonly string[] {
  return [...COMMON_ARGS, ...inputThreadArgs(output), "-i", inputPath, "-map", "0:v:0", "-an", ...outputThreadArgs(output), "-fps_mode", "passthrough", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-pix_fmt", "yuv420p", "-f", "matroska", outputPath];
}

/** An ffconcat list that shows each UI image for its span; the concat demuxer ignores the last duration unless the last file repeats. */
export function overlayListFor(segment: VideoSegment, overlayPath: (sceneKey: string) => string, fps: number): string {
  const lines = ["ffconcat version 1.0"];
  for (const span of segment.spans) {
    lines.push(`file '${escapeConcatPath(overlayPath(span.sceneKey))}'`, `duration ${seconds((span.endFrame - span.startFrame) / fps)}`);
  }
  const last = segment.spans.at(-1);
  if (last !== undefined) lines.push(`file '${escapeConcatPath(overlayPath(last.sceneKey))}'`);
  return `${lines.join("\n")}\n`;
}

export function segmentListFor(paths: readonly string[]): string {
  return `${["ffconcat version 1.0", ...paths.map((path) => `file '${escapeConcatPath(path)}'`)].join("\n")}\n`;
}

function escapeConcatPath(path: string): string {
  return path.replaceAll("'", "'\\''");
}

export function segmentArgs(segment: VideoSegment, sources: ReadonlyMap<string, PlannedSource>, overlayListPath: string, outputPath: string, output: ComposeOutput): readonly string[] {
  const frames = segment.endFrame - segment.startFrame;
  const startSeconds = segment.startFrame / output.fps;
  // One extra frame of input keeps the last output frame from racing the source's end.
  const inputSeconds = (frames + 1) / output.fps;
  const args: string[] = [...COMMON_ARGS];
  for (const placement of segment.placements) {
    const source = sources.get(placement.sourceId);
    if (source === undefined) throw new TypeError(`composed video source ${placement.sourceId} has no decoded media`);
    const offset = Math.max(0, startSeconds - source.startMs / 1_000);
    args.push(...inputThreadArgs(output), "-ss", seconds(offset), "-t", seconds(inputSeconds), "-i", source.path);
  }
  args.push("-f", "concat", "-safe", "0", "-i", overlayListPath);
  const firstFrameHolds = new Map(segment.placements.map((placement) => [placement.sourceId, Math.max(0, sources.get(placement.sourceId)!.startMs / 1_000 - startSeconds)]));
  args.push(...outputThreadArgs(output), "-filter_complex", segmentFilter(segment.placements, output, firstFrameHolds), "-map", "[out]");
  args.push("-frames:v", String(frames), "-r", String(output.fps), "-fps_mode", "cfr");
  // The final mux writes one timestamp per composed frame in packet order.
  args.push(...encoderArgs(output.encoder), "-bf", "0", "-b:v", "2M", "-maxrate", "3M", "-bufsize", "4M", "-pix_fmt", "yuv420p", "-an", "-f", "mpegts", outputPath);
  return args;
}

export function segmentFilter(placements: readonly VideoPlacement[], output: ComposeOutput, firstFrameHolds: ReadonlyMap<string, number> = new Map()): string {
  const { width, height, fps } = output;
  const chains = [`color=c=black:s=${width}x${height}:r=${fps},format=yuv420p[base0]`];
  for (const [index, placement] of placements.entries()) {
    const { x, y, width: tileWidth, height: tileHeight } = placement.rect;
    const fit =
      placement.fit === "cover"
        ? `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${tileWidth}:${tileHeight}`
        : `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:black`;
    const holdSeconds = firstFrameHolds.get(placement.sourceId) ?? 0;
    // Shift real frames to their recording time, then let fps fill backward.
    // tpad would round a delay to input frames (a sparse share can be 1 fps).
    const offset = holdSeconds > 0 ? `+${seconds(holdSeconds)}/TB` : "";
    const cadence = holdSeconds > 0 ? `fps=${fps}:start_time=0` : `fps=${fps}`;
    chains.push(`[${index}:v]setpts=PTS-STARTPTS${offset},${cadence},${fit},setsar=1,format=yuv420p[video${index}]`);
    chains.push(`[base${index}][video${index}]overlay=${x}:${y}:eof_action=repeat[base${index + 1}]`);
  }
  const overlayInput = placements.length;
  // No fps filter on the UI: each image covers a whole span, and fps would hold
  // it until the next one arrives while overlay queues every base frame (>1 GB).
  // Overlay already repeats the latest UI image for each base frame.
  chains.push(`[${overlayInput}:v]format=yuva420p[ui]`);
  chains.push(`[base${placements.length}][ui]overlay=0:0:format=yuv420:eof_action=repeat[out]`);
  return chains.join(";");
}

export function muxArgs(segmentListPath: string, audioPath: string, outputPath: string, frameCount: number, output: ComposeOutput): readonly string[] {
  const outputSeconds = frameCount / output.fps;
  return [
    ...COMMON_ARGS,
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    segmentListPath,
    "-i",
    audioPath,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    ...outputThreadArgs(output),
    "-c:v",
    "copy",
    "-r",
    String(output.fps),
    // MPEG-TS concat can introduce sub-frame timestamp gaps at segment edges.
    // Restore the composed cadence without adding, dropping, or encoding frames.
    "-bsf:v",
    `setts=ts=N/(${output.fps}*TB):duration=1/(${output.fps}*TB)`,
    "-af",
    `asetpts=PTS-STARTPTS,aresample=48000:async=1:first_pts=0,apad,atrim=end=${seconds(outputSeconds)}`,
    "-c:a",
    "aac",
    "-profile:a",
    "aac_low",
    "-b:a",
    "128k",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-tag:v",
    "avc1",
    "-movflags",
    "+faststart",
    outputPath,
  ];
}
