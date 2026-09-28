import type { VideoPlacement, VideoSegment } from "./scene.js";

export type ComposeEncoder = "libx264" | "h264_videotoolbox";

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
  // veryfast keeps x264 under the compositor's own cost; Episode video at 2 Mb/s
  // shows no visible loss against medium, which costs about twice the CPU.
  if (encoder === "libx264") return ["-c:v", "libx264", "-preset", "veryfast", "-profile:v", "high"];
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
  args.push(...outputThreadArgs(output), "-filter_complex", segmentFilter(segment.placements, output), "-map", "[out]");
  args.push("-frames:v", String(frames), "-r", String(output.fps), "-fps_mode", "cfr");
  args.push(...encoderArgs(output.encoder), "-b:v", "2M", "-maxrate", "3M", "-bufsize", "4M", "-pix_fmt", "yuv420p", "-an", "-f", "mpegts", outputPath);
  return args;
}

export function segmentFilter(placements: readonly VideoPlacement[], output: ComposeOutput): string {
  const { width, height, fps } = output;
  const chains = [`color=c=black:s=${width}x${height}:r=${fps},format=yuv420p[base0]`];
  for (const [index, placement] of placements.entries()) {
    const { x, y, width: tileWidth, height: tileHeight } = placement.rect;
    const fit =
      placement.fit === "cover"
        ? `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=increase:force_divisible_by=2,crop=${tileWidth}:${tileHeight}`
        : `scale=${tileWidth}:${tileHeight}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${tileWidth}:${tileHeight}:(ow-iw)/2:(oh-ih)/2:black`;
    chains.push(`[${index}:v]setpts=PTS-STARTPTS,fps=${fps},${fit},setsar=1,format=yuv420p[video${index}]`);
    chains.push(`[base${index}][video${index}]overlay=${x}:${y}:eof_action=repeat[base${index + 1}]`);
  }
  const overlayInput = placements.length;
  chains.push(`[${overlayInput}:v]fps=${fps},format=yuva420p[ui]`);
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
