import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { basename, dirname, join } from "node:path";
import { annotationGeometryArgs, denseKeyframeArgs, keyframeProbeArgs, muxArgs, needsDenseKeyframes, overlayListFor, segmentArgs, segmentListFor, type ComposeOutput, type PlannedSource } from "./compose/plan.js";
import { COMPOSE_RESULT_VERSION } from "./generated/render-contract.js";
import { paintOverlays } from "./compose/overlay-files.js";
import { createAnnotationTimeline, type AnnotationGeometry } from "./compose/annotation-timeline.js";
import { buildSceneSpans, frameCountFor, groupVideoSegments, type VideoSegment } from "./compose/scene.js";
import { loadVerifiedRenderInputs, type VerifiedRenderInputs } from "./node/inputs.js";
import { isMainModule } from "./node/main-module.js";
import { readComposeRequest, validateResultPath } from "./node/request.js";

import { parseArguments } from "./node/compose-arguments.js";

export { parseArguments };

const FONTS_DIRECTORY = fileURLToPath(new URL("./fonts/", import.meta.url));

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
}

const running = new Set<ChildProcess>();

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const request = await readComposeRequest(args.requestPath);
  await Promise.all([validateResultPath(args.resultPath, request.workspaceDirectory), validateResultPath(args.outputPath, request.workspaceDirectory)]);
  const inputs = await loadVerifiedRenderInputs(request, args.annotationFile);
  const output: ComposeOutput = { width: request.width, height: request.height, fps: request.fps, encoder: args.encoder, ...(args.threads === undefined ? {} : { threads: args.threads }) };
  const workDirectory = join(inputs.workspaceDirectory, "compose");
  await mkdir(workDirectory, { mode: 0o700 });
  try {
    const spans = buildSceneSpans(inputs.timeline, inputs.media, output.fps, output);
    const segments = groupVideoSegments(spans);
    const frameCount = frameCountFor(inputs.timeline.clock.durationMs, output.fps);

    const sources = await seekableSources(args.ffmpegPath, inputs, segments, output, workDirectory);
    const composedSegments = await annotateSegments(args.ffmpegPath, inputs, segments, sources, output);
    const segmentPaths = await encodeSegments(args.ffmpegPath, composedSegments, sources, inputs, output, workDirectory);

    const segmentListPath = join(workDirectory, "segments.ffconcat");
    await writeFile(segmentListPath, segmentListFor(segmentPaths), { mode: 0o600 });
    await runTool(args.ffmpegPath, muxArgs(segmentListPath, inputs.mixPath, args.outputPath, frameCount, output), "ffmpeg mux");

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
    };
    await writeFile(args.resultPath, `${JSON.stringify(result)}\n`, { flag: "wx", mode: 0o600 });
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

async function annotateSegments(ffmpegPath: string, inputs: VerifiedRenderInputs, segments: readonly VideoSegment[], sources: ReadonlyMap<string, PlannedSource>, output: ComposeOutput): Promise<readonly { readonly segment: VideoSegment; readonly annotated: boolean }[]> {
  const annotation = createAnnotationTimeline(inputs.annotation, output.fps);
  const composedSegments = [];
  for (const segment of segments) {
    const sourceId = annotation.sourceFor(segment);
    const video = findAnnotationVideo(segment, sources, sourceId);
    if (!video) {
      composedSegments.push({ segment, annotated: false });
      continue;
    }
    const { source, placement } = video;
    const geometry = await probeAnnotationGeometry(ffmpegPath, source, segment, placement, output);
    composedSegments.push({ segment: annotation.apply(segment, video.sourceId, source.startMs, geometry), annotated: true });
  }
  return composedSegments;
}

function findAnnotationVideo(segment: VideoSegment, sources: ReadonlyMap<string, PlannedSource>, sourceId: string | undefined) {
  if (sourceId === undefined) return undefined;
  const source = sources.get(sourceId);
  const placement = segment.placements.find((item) => item.sourceId === sourceId);
  return source && placement ? { source, placement, sourceId } : undefined;
}

async function encodeSegments(ffmpegPath: string, composedSegments: readonly { readonly segment: VideoSegment; readonly annotated: boolean }[], sources: ReadonlyMap<string, PlannedSource>, inputs: VerifiedRenderInputs, output: ComposeOutput, workDirectory: string): Promise<readonly string[]> {
  const overlays = await paintOverlays(
    composedSegments.flatMap(({ segment }) => segment.spans),
    inputs,
    output,
    workDirectory,
    FONTS_DIRECTORY,
  );
  const segmentPaths: string[] = [];
  for (const [index, { segment, annotated }] of composedSegments.entries()) {
    const listPath = join(workDirectory, `overlays-${index}.ffconcat`);
    const segmentPath = join(workDirectory, `segment-${index}.ts`);
    await writeFile(
      listPath,
      overlayListFor(segment, (sceneKey) => overlays.get(sceneKey)!, output.fps, annotated),
      { mode: 0o600 },
    );
    await runTool(ffmpegPath, segmentArgs(segment, sources, listPath, segmentPath, output), `ffmpeg segment ${index}`);
    segmentPaths.push(segmentPath);
  }

  return segmentPaths;
}

/**
 * Video sources as recorded, except tracks whose sparse keyframes would make
 * the segments' seeks decode more than a one-off re-encode costs.
 */
async function seekableSources(ffmpegPath: string, inputs: VerifiedRenderInputs, segments: readonly VideoSegment[], output: ComposeOutput, workDirectory: string): Promise<ReadonlyMap<string, PlannedSource>> {
  const sources = new Map<string, PlannedSource>();
  let denseCount = 0;
  for (const source of inputs.media.sources) {
    const file = inputs.mediaFiles.get(source.sourceId);
    if (source.kind === "microphone" || file === undefined) continue;
    const starts = segments.filter((segment) => segment.placements.some((placement) => placement.sourceId === source.sourceId)).map((segment) => Math.max(0, segment.startFrame / output.fps - source.startMs / 1_000));
    const prepared = await prepareSeekableSource(ffmpegPath, inputs.media, source, file.path, starts, output, join(workDirectory, `dense-${denseCount}.mkv`));
    sources.set(source.sourceId, prepared.source);
    if (prepared.densified) denseCount++;
  }
  return sources;
}

async function prepareSeekableSource(
  ffmpegPath: string,
  media: VerifiedRenderInputs["media"],
  source: VerifiedRenderInputs["media"]["sources"][number],
  path: string,
  starts: readonly number[],
  output: ComposeOutput,
  densePath: string,
): Promise<{ readonly source: PlannedSource; readonly densified: boolean }> {
  if (starts.length === 0) return { source: { path, startMs: source.startMs, changingSize: false }, densified: false };
  const { keyframes, changingSize, keepRecordedFrames } = await probeSourceFrames(ffmpegPath, path);
  const frozenSeek = hasFrozenSeek(media, source, starts);
  const duration = (source.endMs - source.startMs) / 1_000;
  if (keepRecordedFrames && frozenSeek) return { source: { path, startMs: source.startMs, changingSize, decodeFromStartSeconds: duration }, densified: false };
  // A fixed-size dense encode would discard changing aspect ratios/detail;
  // yuv420p x264 also rejects odd dimensions. Compose these frames directly.
  if (!keepRecordedFrames && (frozenSeek || needsDenseKeyframes(keyframes, starts, duration))) {
    await runTool(ffmpegPath, denseKeyframeArgs(path, densePath, output, frozenSeek ? duration : undefined), `ffmpeg dense keyframes ${source.sourceId}`);
    return { source: { path: densePath, startMs: source.startMs, changingSize }, densified: true };
  }
  return { source: { path, startMs: source.startMs, changingSize }, densified: false };
}

async function probeSourceFrames(ffmpegPath: string, path: string) {
  const pictures = (await runTool(ffprobePathFor(ffmpegPath), keyframeProbeArgs(path), "ffprobe"))
    .split("\n")
    .map((line) => line.split(","))
    .filter((fields) => Number.isFinite(Number.parseFloat(fields[0] ?? "")));
  const keyframes = pictures.map((fields) => Number.parseFloat(fields[0]!));
  const changingSize = new Set(pictures.map((fields) => fields.slice(1, 3).join("x"))).size > 1;
  const oddSize = pictures.some((fields) => fields.slice(1, 3).some((dimension) => Number(dimension) % 2 !== 0));
  return { keyframes, changingSize, keepRecordedFrames: changingSize || oddSize };
}

function hasFrozenSeek(media: VerifiedRenderInputs["media"], source: VerifiedRenderInputs["media"]["sources"][number], starts: readonly number[]): boolean {
  return media.discontinuities.some((gap) => gap.sourceId === source.sourceId && (gap.endMs >= source.endMs || starts.some((start) => start * 1_000 + source.startMs >= gap.startMs && start * 1_000 + source.startMs < gap.endMs)));
}

function ffprobePathFor(ffmpegPath: string): string {
  return basename(ffmpegPath) === ffmpegPath ? "ffprobe" : join(dirname(ffmpegPath), "ffprobe");
}

async function probeAnnotationGeometry(ffmpegPath: string, source: PlannedSource, segment: VideoSegment, placement: VideoSegment["placements"][number], output: ComposeOutput): Promise<readonly AnnotationGeometry[]> {
  const result: AnnotationGeometry[] = [];
  let previousSize = "";
  await runTool(ffmpegPath, annotationGeometryArgs(source, segment, placement, output), "recording annotation geometry", (line) => {
    const match = /Parsed_showinfo_.* n:\s*(\d+).* s:(\d+)x(\d+) /.exec(line);
    if (match === null) return;
    const [, number, rawWidth, rawHeight] = match;
    const size = `${rawWidth}x${rawHeight}`;
    if (previousSize === size) return;
    previousSize = size;
    const width = Number(rawWidth);
    const height = Number(rawHeight);
    // FFmpeg pads the 4:2:0 screen on an even chroma boundary.
    const x = placement.rect.x + Math.floor((placement.rect.width - width) / 4) * 2;
    const y = placement.rect.y + Math.floor((placement.rect.height - height) / 4) * 2;
    result.push({ frame: segment.startFrame + Number(number), content: { x, y, width, height } });
  });
  if (result[0]?.frame !== segment.startFrame) throw new TypeError("recording annotation has no decoded screen geometry");
  return result;
}

async function runTool(path: string, args: readonly string[], label: string, onStderrLine?: (line: string) => void): Promise<string> {
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
  if (onStderrLine !== undefined) createInterface({ input: child.stderr }).on("line", onStderrLine);
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

if (isMainModule(import.meta.url)) {
  await main().catch((error: unknown) => {
    for (const child of running) child.kill("SIGKILL");
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exitCode = 1;
  });
}
