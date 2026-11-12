import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { deriveRecordingMediaSourceId, type RecordingMediaSourceV1, type RecordingPresentationAssetV1 } from "@q9labsai/recording-presentation";
import { parseDecodedMediaIndexV1 } from "./decoded-media.js";
import { EPISODE_ID, fixtureTimeline, momentAt, ORIGIN_AUTHORITY_ID, PEOPLE, RECORDING_ID, type FixtureSources } from "./fixture/scenario.js";
import { whiteboardState } from "./fixture/whiteboard-state.js";
import { isMainModule } from "./node/main-module.js";

// Writes the inputs of a heavy Episode for the native compositor (see fixture/scenario.ts). Dev and benchmark use only.

interface FixtureArguments {
  readonly outputDirectory: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
  readonly fps: number;
  readonly colorScheme: "light" | "dark";
  readonly mediaDirectory?: string;
}

interface FileFacts {
  readonly byteSize: number;
  readonly sha256: string;
}

const MEDIA_FILES = ["cam1.webm", "cam2.webm", "cam3.webm", "screen.webm", "mix.wav"];

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const duration = args.durationMs;
  const { assetsDirectory, mediaDirectory } = await createFixtureDirectories(args.outputDirectory);
  const screenStartMs = momentAt(duration, 0.2);
  const screenEndMs = momentAt(duration, 0.5);
  await prepareMedia(args, mediaDirectory, screenEndMs - screenStartMs);

  const assets = await writeWhiteboardAssets(assetsDirectory);
  const sources: FixtureSources = {
    cameras: await Promise.all(PEOPLE.map((person, index) => sourceFor(person.id, "camera", `camera-${index + 1}`))),
    screen: await sourceFor(PEOPLE[1].id, "screen_share", "screen-1"),
    screenStartMs,
    screenEndMs,
    whiteboardAssetIds: [assets[0].id, assets[1].id],
  };
  const timeline = fixtureTimeline(args, sources, assets);
  const decodedMedia = await decodedMediaIndex(mediaDirectory, duration, sources);
  parseDecodedMediaIndexV1(decodedMedia);

  const presentationPath = join(args.outputDirectory, "recording-presentation.json");
  const decodedMediaPath = join(mediaDirectory, "decoded-media.json");
  await Promise.all([writeJSON(presentationPath, timeline), writeJSON(decodedMediaPath, decodedMedia)]);
  const [presentationFacts, decodedFacts] = await Promise.all([fileFacts(presentationPath), fileFacts(decodedMediaPath)]);
  const requestPath = join(args.outputDirectory, "frame-request.json");
  await writeJSON(requestPath, {
    schema_version: "recording-frame-render-request.v1",
    recording_id: RECORDING_ID,
    episode_id: EPISODE_ID,
    workspace_directory: args.outputDirectory,
    presentation_path: presentationPath,
    presentation_sha256: presentationFacts.sha256,
    asset_directory: assetsDirectory,
    decoded_media_path: decodedMediaPath,
    decoded_media_sha256: decodedFacts.sha256,
    width: args.width,
    height: args.height,
    fps: args.fps,
    duration_ms: duration,
  });
  process.stdout.write(`${JSON.stringify({ requestPath, resultPath: join(args.outputDirectory, "compose-result.json"), outputPath: join(args.outputDirectory, "export.mp4") })}\n`);
}

async function sourceFor(participantId: string, kind: RecordingMediaSourceV1["kind"], trackId: string): Promise<RecordingMediaSourceV1> {
  const sourceId = await deriveRecordingMediaSourceId({ recordingId: RECORDING_ID, participantId, participantGeneration: 1, kind, trackId, epoch: 1 });
  return { sourceId, participantId, participantGeneration: 1, kind, trackId, epoch: 1, visible: true };
}

/** Stores both whiteboard revisions under their content hash, where the compositor looks for assets. */
async function writeWhiteboardAssets(assetsDirectory: string): Promise<readonly [RecordingPresentationAssetV1, RecordingPresentationAssetV1]> {
  const write = async (revision: 1 | 2): Promise<RecordingPresentationAssetV1> => {
    const id = `whiteboard-state-${revision}`;
    const bytes = whiteboardState(revision);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(assetsDirectory, sha256), bytes, { flag: "wx", mode: 0o600 });
    return { id, kind: "whiteboard_state", objectKey: `fixture/${id}`, contentType: "application/json", byteSize: bytes.byteLength, sha256 };
  };
  return [await write(1), await write(2)];
}

async function decodedMediaIndex(mediaDirectory: string, duration: number, sources: FixtureSources) {
  const sourceEntry = async (source: RecordingMediaSourceV1, file: string, startMs: number, endMs: number): Promise<object> => {
    const facts = await fileFacts(join(mediaDirectory, file));
    return {
      source_id: source.sourceId,
      participant_id: source.participantId,
      participant_generation: source.participantGeneration,
      track_id: source.trackId,
      track_epoch: source.epoch,
      kind: source.kind,
      codec: "vp8",
      container: "webm",
      content_type: "video/webm",
      path: file,
      byte_size: facts.byteSize,
      sha256: facts.sha256,
      start_ms: startMs,
      end_ms: endMs,
    };
  };
  const mixFacts = await fileFacts(join(mediaDirectory, "mix.wav"));
  return {
    schema_version: "decoded_media.v1",
    recording_id: RECORDING_ID,
    episode_id: EPISODE_ID,
    clock: { origin: "capture_ready", timebase: "recording_relative_ms", origin_authority_id: ORIGIN_AUTHORITY_ID, capture_epoch: 1, duration_ms: duration },
    sources: [...(await Promise.all(sources.cameras.map((camera, index) => sourceEntry(camera, `cam${index + 1}.webm`, 0, duration)))), await sourceEntry(sources.screen, "screen.webm", sources.screenStartMs, sources.screenEndMs)],
    mix: { path: "mix.wav", codec: "pcm_s16le", container: "wav", content_type: "audio/wav", sample_rate_hz: 48_000, channels: 2, byte_size: mixFacts.byteSize, sha256: mixFacts.sha256, start_ms: 0, end_ms: duration },
    discontinuities: [{ source_id: sources.screen.sourceId, track_id: sources.screen.trackId, track_epoch: 1, start_ms: momentAt(duration, 0.4), end_ms: momentAt(duration, 0.42), reason: "source_gap" }],
  };
}

/** Copies prepared media when given, otherwise encodes VP8 test sources the way LiveKit egress would: default keyframe spacing. */
async function prepareMedia(args: FixtureArguments, mediaDirectory: string, screenDurationMs: number): Promise<void> {
  if (args.mediaDirectory !== undefined) {
    for (const file of MEDIA_FILES) await copyFile(join(args.mediaDirectory, file), join(mediaDirectory, file));
    return;
  }
  const seconds = String(args.durationMs / 1_000);
  const vp8 = ["-c:v", "libvpx", "-b:v", "1M", "-deadline", "realtime", "-cpu-used", "8", "-threads", "2", "-an"];
  const ffmpeg = (inputs: readonly string[], output: readonly string[]): Promise<void> => run("nice", ["-n", "15", "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", ...inputs, ...output]);
  for (const [index, person] of PEOPLE.entries()) {
    await ffmpeg(["-f", "lavfi", "-i", `testsrc2=size=640x480:rate=30:duration=${seconds}`], ["-vf", `hue=h=${person.hue}`, ...vp8, join(mediaDirectory, `cam${index + 1}.webm`)]);
  }
  await ffmpeg(["-f", "lavfi", "-i", `testsrc=size=1280x720:rate=30:duration=${screenDurationMs / 1_000}`], [...vp8, join(mediaDirectory, "screen.webm")]);
  await ffmpeg(["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${seconds}`], ["-ac", "2", "-c:a", "pcm_s16le", join(mediaDirectory, "mix.wav")]);
}

async function createFixtureDirectories(outputDirectory: string): Promise<{ assetsDirectory: string; mediaDirectory: string }> {
  await mkdir(outputDirectory, { mode: 0o700 });
  const assetsDirectory = join(outputDirectory, "assets");
  const mediaDirectory = join(outputDirectory, "media");
  await Promise.all([mkdir(assetsDirectory, { mode: 0o700 }), mkdir(mediaDirectory, { mode: 0o700 })]);
  return { assetsDirectory, mediaDirectory };
}

async function run(command: string, args: readonly string[]): Promise<void> {
  const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
  const errors: Buffer[] = [];
  child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  if (outcome.code !== 0) throw new Error(`${command} failed (${outcome.signal ?? String(outcome.code)}): ${Buffer.concat(errors).toString("utf8").trim()}`);
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  const contents = `${JSON.stringify(value)}\n`;
  await writeFile(path, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function fileFacts(path: string): Promise<FileFacts> {
  const bytes = await readFile(path);
  return { byteSize: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
}

function fixtureOptions(values: readonly string[], usage: string): ReadonlyMap<string, string> {
  const options = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) throw new TypeError(usage);
    options.set(key, value);
  }
  return options;
}

export function parseArguments(values: readonly string[]): FixtureArguments {
  const usage = "usage: compose-fixture --output <absolute-path> [--width 1280] [--height 720] [--duration-ms 120000] [--fps 15] [--color-scheme light|dark] [--media <dir with cam1-3.webm, screen.webm, mix.wav>]";
  const options = fixtureOptions(values, usage);
  const outputDirectory = options.get("--output");
  if (outputDirectory === undefined || !isAbsolute(outputDirectory)) throw new TypeError(usage);
  const colorScheme = options.get("--color-scheme") ?? "light";
  if (colorScheme !== "light" && colorScheme !== "dark") throw new TypeError(usage);
  const durationMs = Number(options.get("--duration-ms") ?? 120_000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 10_000) throw new TypeError("--duration-ms must be at least 10000");
  const mediaDirectory = options.get("--media");
  return {
    outputDirectory,
    width: Number(options.get("--width") ?? 1_280),
    height: Number(options.get("--height") ?? 720),
    durationMs,
    fps: Number(options.get("--fps") ?? 15),
    colorScheme,
    ...(mediaDirectory === undefined ? {} : { mediaDirectory }),
  };
}

if (isMainModule(import.meta.url)) {
  main().catch((error: unknown) => {
    process.stderr.write(`compose-fixture: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
