import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadImage, type Image } from "@napi-rs/canvas";
import { denseKeyframeArgs, keyframeProbeArgs, muxArgs, needsDenseKeyframes, overlayListFor, segmentArgs, segmentListFor, type ComposeEncoder, type ComposeOutput, type PlannedSource } from "./compose/plan.js";
import { registerSubsetFamily, registerTextFallback } from "./compose/fonts.js";
import { createPainter } from "./compose/paint.js";
import { buildSceneSpans, frameCountFor, groupVideoSegments, type VideoSegment } from "./compose/scene.js";
import { createWhiteboardRenderer } from "./compose/whiteboard.js";
import { loadVerifiedRenderInputs, type VerifiedRenderInputs } from "./node/inputs.js";
import { readFrameRenderRequest, validateResultPath } from "./node/request.js";

const COMPOSE_RESULT_VERSION = "recording-compose-result.v1";
const FONTS_DIRECTORY = fileURLToPath(new URL("./fonts/", import.meta.url));

interface Arguments {
  readonly requestPath: string;
  readonly resultPath: string;
  readonly outputPath: string;
  readonly ffmpegPath: string;
  readonly encoder: ComposeEncoder;
  readonly threads?: number;
}

interface ComposeResultV1 {
  readonly schema_version: typeof COMPOSE_RESULT_VERSION;
  readonly recording_id: string;
  readonly episode_id: string;
  readonly presentation_sha256: string;
  readonly decoded_media_sha256: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly frame_count: number;
  readonly overlay_count: number;
  readonly segment_count: number;
  readonly dense_keyframe_source_count: number;
  readonly plan_wall_ms: number;
  readonly paint_wall_ms: number;
  readonly composite_wall_ms: number;
  readonly mux_wall_ms: number;
  readonly wall_duration_ms: number;
}

const running = new Set<ChildProcess>();

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const started = performance.now();
  const request = await readFrameRenderRequest(args.requestPath);
  await Promise.all([validateResultPath(args.resultPath, request.workspaceDirectory), validateResultPath(args.outputPath, request.workspaceDirectory)]);
  const inputs = await loadVerifiedRenderInputs(request);
  const output: ComposeOutput = { width: request.width, height: request.height, fps: request.fps, encoder: args.encoder, ...(args.threads === undefined ? {} : { threads: args.threads }) };
  const workDirectory = join(inputs.workspaceDirectory, "compose");
  await mkdir(workDirectory, { mode: 0o700 });
  try {
    const planStarted = performance.now();
    const spans = buildSceneSpans(inputs.timeline, inputs.media, output.fps, output);
    const segments = groupVideoSegments(spans);
    const frameCount = frameCountFor(inputs.timeline.clock.durationMs, output.fps);
    const planWallMs = performance.now() - planStarted;

    const paintStarted = performance.now();
    const overlays = await paintOverlays(spans, inputs, output, workDirectory);
    const paintWallMs = performance.now() - paintStarted;

    const compositeStarted = performance.now();
    const { sources, denseCount } = await seekableSources(args.ffmpegPath, inputs, segments, output, workDirectory);
    const segmentPaths: string[] = [];
    for (const [index, segment] of segments.entries()) {
      const listPath = join(workDirectory, `overlays-${index}.ffconcat`);
      const segmentPath = join(workDirectory, `segment-${index}.ts`);
      await writeFile(
        listPath,
        overlayListFor(segment, (sceneKey) => overlays.get(sceneKey)!, output.fps),
        { mode: 0o600 },
      );
      await runFFmpeg(args.ffmpegPath, segmentArgs(segment, sources, listPath, segmentPath, output), `segment ${index}`);
      segmentPaths.push(segmentPath);
    }
    const compositeWallMs = performance.now() - compositeStarted;

    const muxStarted = performance.now();
    const segmentListPath = join(workDirectory, "segments.ffconcat");
    await writeFile(segmentListPath, segmentListFor(segmentPaths), { mode: 0o600 });
    await runFFmpeg(args.ffmpegPath, muxArgs(segmentListPath, inputs.mixPath, args.outputPath, frameCount, output), "mux");
    const muxWallMs = performance.now() - muxStarted;

    const result: ComposeResultV1 = {
      schema_version: COMPOSE_RESULT_VERSION,
      recording_id: request.recordingId,
      episode_id: request.episodeId,
      presentation_sha256: request.presentationSha256,
      decoded_media_sha256: request.decodedMediaSha256,
      width: output.width,
      height: output.height,
      fps: output.fps,
      frame_count: frameCount,
      overlay_count: overlays.size,
      segment_count: segments.length,
      dense_keyframe_source_count: denseCount,
      plan_wall_ms: Math.round(planWallMs),
      paint_wall_ms: Math.round(paintWallMs),
      composite_wall_ms: Math.round(compositeWallMs),
      mux_wall_ms: Math.round(muxWallMs),
      wall_duration_ms: Math.round(performance.now() - started),
    };
    await writeFile(args.resultPath, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function paintOverlays(spans: ReturnType<typeof buildSceneSpans>, inputs: VerifiedRenderInputs, output: ComposeOutput, workDirectory: string): Promise<ReadonlyMap<string, string>> {
  await registerTextFallback(join(FONTS_DIRECTORY, "excalidraw", "Liberation"));
  const fontFamilies = await registerSubsetFamily("Figtree", join(FONTS_DIRECTORY, "Figtree"));
  const images = new Map<string, Promise<Image>>();
  const assetPath = (assetId: string): string => {
    const asset = inputs.assets.get(assetId);
    if (asset === undefined) throw new TypeError(`recording asset ${assetId} is not verified`);
    return asset.path;
  };
  const painter = createPainter({
    width: output.width,
    height: output.height,
    fontFamilies,
    loadAsset: (assetId) => {
      let image = images.get(assetId);
      if (image === undefined) {
        image = readFile(assetPath(assetId)).then((bytes) => loadImage(bytes));
        images.set(assetId, image);
      }
      return image;
    },
    renderWhiteboard: createWhiteboardRenderer({
      fontsDirectory: join(FONTS_DIRECTORY, "excalidraw"),
      loadAsset: async (assetId) => ({ bytes: await readFile(assetPath(assetId)), contentType: inputs.assets.get(assetId)!.contentType }),
    }),
  });
  const overlays = new Map<string, string>();
  for (const span of spans) {
    if (overlays.has(span.sceneKey)) continue;
    const path = join(workDirectory, `overlay-${overlays.size}.png`);
    await writeFile(path, await painter.paint(span.scene), { mode: 0o600 });
    overlays.set(span.sceneKey, path);
  }
  return overlays;
}

/**
 * Video sources as recorded, except tracks whose sparse keyframes would make
 * the segments' seeks decode more than a one-off re-encode costs.
 */
async function seekableSources(ffmpegPath: string, inputs: VerifiedRenderInputs, segments: readonly VideoSegment[], output: ComposeOutput, workDirectory: string): Promise<{ readonly sources: ReadonlyMap<string, PlannedSource>; readonly denseCount: number }> {
  const sources = new Map<string, PlannedSource>();
  let denseCount = 0;
  for (const source of inputs.media.sources) {
    const file = inputs.mediaFiles.get(source.sourceId);
    if (source.kind === "microphone" || file === undefined) continue;
    const starts = segments.filter((segment) => segment.placements.some((placement) => placement.sourceId === source.sourceId)).map((segment) => Math.max(0, segment.startFrame / output.fps - source.startMs / 1_000));
    let path = file.path;
    if (starts.length > 0) {
      const keyframes = (await runProbe(ffprobePathFor(ffmpegPath), keyframeProbeArgs(path))).split("\n").map(Number.parseFloat).filter(Number.isFinite);
      if (needsDenseKeyframes(keyframes, starts, (source.endMs - source.startMs) / 1_000)) {
        path = join(workDirectory, `dense-${denseCount}.mkv`);
        await runFFmpeg(ffmpegPath, denseKeyframeArgs(file.path, path, output), `dense keyframes ${source.sourceId}`);
        denseCount++;
      }
    }
    sources.set(source.sourceId, { path, startMs: source.startMs });
  }
  return { sources, denseCount };
}

function ffprobePathFor(ffmpegPath: string): string {
  return basename(ffmpegPath) === ffmpegPath ? "ffprobe" : join(dirname(ffmpegPath), "ffprobe");
}

async function runFFmpeg(ffmpegPath: string, args: readonly string[], label: string): Promise<void> {
  await runTool(ffmpegPath, args, `ffmpeg ${label}`);
}

async function runProbe(ffprobePath: string, args: readonly string[]): Promise<string> {
  return runTool(ffprobePath, args, "ffprobe");
}

/** Runs a media tool, tracked so a stopped compositor kills it, and returns its stdout. */
async function runTool(path: string, args: readonly string[], label: string): Promise<string> {
  const child = spawn(path, args, { stdio: ["ignore", "pipe", "pipe"] });
  running.add(child);
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    if (stderr.length < 16_384) stderr += chunk;
  });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    if (code !== 0) throw new Error(`${label} exited with ${code}: ${stderr.trim()}`);
    return stdout;
  } finally {
    running.delete(child);
  }
}

// The worker stops this process with SIGTERM; FFmpeg children must not outlive it.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    for (const child of running) child.kill("SIGKILL");
    process.exit(128 + (signal === "SIGTERM" ? 15 : 2));
  });
}

function composeOptions(values: readonly string[]): ReadonlyMap<string, string> {
  const options = new Map<string, string>();
  let index = 0;
  while (index < values.length) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--") || options.has(key)) throw new TypeError("usage: compose --request <path> --result <path> --output <path> [--ffmpeg <path>] [--encoder libx264|h264_videotoolbox] [--threads <n>]");
    options.set(key, value);
    index += 2;
  }
  for (const key of options.keys()) {
    if (!["--request", "--result", "--output", "--ffmpeg", "--encoder", "--threads"].includes(key)) throw new TypeError(`unknown compose option ${key}`);
  }
  return options;
}

function absoluteOption(options: ReadonlyMap<string, string>, key: string): string {
  const value = options.get(key);
  if (value === undefined || !isAbsolute(value)) throw new TypeError(`${key} must be an absolute path`);
  return value;
}

export function parseArguments(values: readonly string[]): Arguments {
  const options = composeOptions(values);
  const encoder = options.get("--encoder") ?? "libx264";
  if (encoder !== "libx264" && encoder !== "h264_videotoolbox") throw new TypeError(`unsupported compose encoder ${encoder}`);
  const threads = options.has("--threads") ? Number(options.get("--threads")) : undefined;
  if (threads !== undefined && (!Number.isSafeInteger(threads) || threads < 1 || threads > 64)) throw new TypeError("--threads must be between 1 and 64");
  return {
    requestPath: absoluteOption(options, "--request"),
    resultPath: absoluteOption(options, "--result"),
    outputPath: absoluteOption(options, "--output"),
    ffmpegPath: options.get("--ffmpeg") ?? "ffmpeg",
    encoder,
    ...(threads === undefined ? {} : { threads }),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error: unknown) => {
    for (const child of running) child.kill("SIGKILL");
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
