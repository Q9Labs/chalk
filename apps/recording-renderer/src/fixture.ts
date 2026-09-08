import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deriveRecordingMediaSourceId, parseRecordingPresentationTimelineV1 } from "@q9labsai/recording-presentation";
import { parseDecodedMediaIndexV1 } from "./decoded-media.js";
import { readClientBuildManifest } from "./node/ui-build.js";

const RECORDING_ID = "00000000-0000-4000-8000-000000000101";
const EPISODE_ID = "00000000-0000-4000-8000-000000000102";
const SPACE_ID = "00000000-0000-4000-8000-000000000103";
const ORIGIN_AUTHORITY_ID = "00000000-0000-4000-8000-000000000104";
const CAMERA_PARTICIPANT_ID = "00000000-0000-4000-8000-000000000105";
const SHARE_PARTICIPANT_ID = "00000000-0000-4000-8000-000000000106";

interface FixtureArguments {
  readonly outputDirectory: string;
  readonly width: number;
  readonly height: number;
  readonly durationMs: number;
}

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const uiBuild = await readClientBuildManifest(fileURLToPath(new URL("../client/", import.meta.url)));
  await mkdir(args.outputDirectory, { mode: 0o700 });
  const assetsDirectory = join(args.outputDirectory, "assets");
  const mediaDirectory = join(args.outputDirectory, "media");
  await Promise.all([mkdir(assetsDirectory, { mode: 0o700 }), mkdir(mediaDirectory, { mode: 0o700 })]);

  const screenPath = join(mediaDirectory, "screen-share.mp4");
  const microphonePath = join(mediaDirectory, "microphone.wav");
  const mixPath = join(mediaDirectory, "mix.wav");
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", `testsrc2=size=640x360:rate=30:duration=${args.durationMs / 1_000}`, "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", screenPath]);
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", `sine=frequency=440:sample_rate=48000:duration=${args.durationMs / 1_000}`, "-ac", "1", "-c:a", "pcm_s16le", microphonePath]);
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-loglevel", "error", "-i", microphonePath, "-af", "pan=stereo|c0=c0|c1=c0", "-c:a", "pcm_s16le", mixPath]);

  const [screenFacts, microphoneFacts, mixFacts, screenSourceId, microphoneSourceId] = await Promise.all([
    fileFacts(screenPath),
    fileFacts(microphonePath),
    fileFacts(mixPath),
    deriveRecordingMediaSourceId({ recordingId: RECORDING_ID, participantId: SHARE_PARTICIPANT_ID, participantGeneration: 1, kind: "screen_share", trackId: "fixture-screen-track", epoch: 1 }),
    deriveRecordingMediaSourceId({ recordingId: RECORDING_ID, participantId: SHARE_PARTICIPANT_ID, participantGeneration: 1, kind: "microphone", trackId: "fixture-microphone-track", epoch: 1 }),
  ]);

  const timeline = parseRecordingPresentationTimelineV1({
    schemaVersion: "recording_presentation.v1",
    recordingId: RECORDING_ID,
    episodeId: EPISODE_ID,
    clock: { origin: "capture_ready", timebase: "recording_relative_ms", captureEpoch: 1, originAuthorityId: ORIGIN_AUTHORITY_ID, durationMs: args.durationMs },
    sourceCursors: {
      episodeControlStartRevision: 1,
      episodeControlEndRevision: 3,
      chatStartSequence: 0,
      chatEndSequence: 1,
      whiteboardStartRevision: 0,
      whiteboardEndRevision: 0,
      capturePlanStartRevision: 1,
      capturePlanEndRevision: 2,
    },
    initial: {
      elapsedMs: 0,
      profile: {
        name: "recording-space",
        version: "recording-space.v1",
        uiBuildSha256: uiBuild.sha256,
        viewport: { width: args.width, height: args.height, deviceScaleFactor: 1 },
        locale: "en",
        timeZone: "UTC",
        fontAssetIds: [],
        theme: { colorScheme: "light", skin: "classic", palette: "light", texture: "none", stageBackground: true, generatedAvatars: true },
      },
      space: { id: SPACE_ID, name: "Recording confidence Space" },
      view: { layout: "presentation", sidebar: "chat" },
      participants: [
        {
          id: CAMERA_PARTICIPANT_ID,
          displayName: "Avery",
          joinOrdinal: 1,
          joined: true,
          microphoneMuted: false,
          cameraEnabled: true,
          screenShareEnabled: false,
          speaking: true,
          activeSpeaker: true,
          handRaised: false,
        },
        {
          id: SHARE_PARTICIPANT_ID,
          displayName: "Morgan",
          joinOrdinal: 2,
          joined: true,
          microphoneMuted: false,
          cameraEnabled: false,
          screenShareEnabled: true,
          speaking: false,
          activeSpeaker: false,
          handRaised: true,
        },
      ],
      media: [
        { sourceId: screenSourceId, participantId: SHARE_PARTICIPANT_ID, participantGeneration: 1, kind: "screen_share", trackId: "fixture-screen-track", epoch: 1, visible: true },
        { sourceId: microphoneSourceId, participantId: SHARE_PARTICIPANT_ID, participantGeneration: 1, kind: "microphone", trackId: "fixture-microphone-track", epoch: 1, visible: false },
      ],
      chat: { retainedFloorSequence: null, headSequence: 0, messages: [] },
      sharedContent: { kind: "screen_share", participantId: SHARE_PARTICIPANT_ID, sourceId: screenSourceId },
      reactions: [],
    },
    events: [
      {
        atMs: 1_000,
        sequence: 1,
        kind: "chat_message_added",
        message: {
          id: "00000000-0000-4000-8000-000000000107",
          sequence: 1,
          participantId: SHARE_PARTICIPANT_ID,
          displayName: "Morgan",
          text: "The shared source is intentionally unavailable at this frame.",
          createdAtMs: 1_000,
          displayTime: "00:01",
          attachments: [],
        },
      },
      {
        atMs: 1_500,
        sequence: 2,
        kind: "reaction_added",
        reaction: {
          id: "00000000-0000-4000-8000-000000000108",
          participantId: CAMERA_PARTICIPANT_ID,
          displayName: "Avery",
          value: "🎉",
          occurredAtMs: 1_500,
          expiresAtMs: 2_800,
        },
      },
    ],
    assets: [],
  });

  const decodedMedia = {
    schema_version: "decoded_media.v1",
    recording_id: RECORDING_ID,
    episode_id: EPISODE_ID,
    clock: { origin: "capture_ready", timebase: "recording_relative_ms", origin_authority_id: ORIGIN_AUTHORITY_ID, capture_epoch: 1, duration_ms: args.durationMs },
    sources: [
      {
        source_id: screenSourceId,
        participant_id: SHARE_PARTICIPANT_ID,
        participant_generation: 1,
        track_id: "fixture-screen-track",
        track_epoch: 1,
        kind: "screen_share",
        codec: "h264",
        container: "mp4",
        content_type: "video/mp4",
        path: "screen-share.mp4",
        byte_size: screenFacts.byteSize,
        sha256: screenFacts.sha256,
        start_ms: 0,
        end_ms: args.durationMs,
      },
      {
        source_id: microphoneSourceId,
        participant_id: SHARE_PARTICIPANT_ID,
        participant_generation: 1,
        track_id: "fixture-microphone-track",
        track_epoch: 1,
        kind: "microphone",
        codec: "pcm_s16le",
        container: "wav",
        content_type: "audio/wav",
        path: "microphone.wav",
        byte_size: microphoneFacts.byteSize,
        sha256: microphoneFacts.sha256,
        start_ms: 0,
        end_ms: args.durationMs,
        sample_rate_hz: 48_000,
        channels: 1,
      },
    ],
    mix: {
      path: "mix.wav",
      codec: "pcm_s16le",
      container: "wav",
      content_type: "audio/wav",
      sample_rate_hz: 48_000,
      channels: 2,
      byte_size: mixFacts.byteSize,
      sha256: mixFacts.sha256,
      start_ms: 0,
      end_ms: args.durationMs,
    },
    discontinuities: [{ source_id: screenSourceId, track_id: "fixture-screen-track", track_epoch: 1, start_ms: 1_000, end_ms: 2_000, reason: "source_gap" }],
  };
  parseDecodedMediaIndexV1(decodedMedia);

  const presentationPath = join(args.outputDirectory, "recording-presentation.json");
  const decodedMediaPath = join(mediaDirectory, "decoded-media.json");
  await writeJSON(presentationPath, timeline);
  await writeJSON(decodedMediaPath, decodedMedia);
  const [presentationFacts, decodedFacts] = await Promise.all([fileFacts(presentationPath), fileFacts(decodedMediaPath)]);
  const requestPath = join(args.outputDirectory, "frame-request.json");
  const resultPath = join(args.outputDirectory, "frame-result.json");
  const inspectionDirectory = join(args.outputDirectory, "inspection");
  await writeJSON(requestPath, {
    schema_version: "recording-frame-render-request.v1",
    recording_id: RECORDING_ID,
    episode_id: EPISODE_ID,
    workspace_directory: args.outputDirectory,
    presentation_path: presentationPath,
    presentation_sha256: presentationFacts.sha256,
    ui_build_sha256: uiBuild.sha256,
    asset_directory: assetsDirectory,
    decoded_media_path: decodedMediaPath,
    decoded_media_sha256: decodedFacts.sha256,
    width: args.width,
    height: args.height,
    fps: 1,
    duration_ms: args.durationMs,
  });
  process.stdout.write(`${JSON.stringify({ requestPath, resultPath, inspectionDirectory, evidenceTimestampMs: 2_000 })}\n`);
}

async function run(command: string, args: readonly string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    const errors: Buffer[] = [];
    child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? String(code)}): ${Buffer.concat(errors).toString("utf8").trim()}`));
    });
  });
}

async function writeJSON(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
}

async function fileFacts(path: string): Promise<{ readonly byteSize: number; readonly sha256: string }> {
  const facts = await stat(path);
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { byteSize: facts.size, sha256: hash.digest("hex") };
}

function parseArguments(values: readonly string[]): FixtureArguments {
  if (!hasFixtureArgumentCount(values.length)) throwFixtureUsage();
  const outputDirectory = readRequiredFixtureOption(values, 0, "--output");
  const width = Number(readRequiredFixtureOption(values, 2, "--width"));
  const height = Number(readRequiredFixtureOption(values, 4, "--height"));
  const durationMs = parseFixtureDuration(values);
  validateFixtureArguments(outputDirectory, width, height, durationMs);
  return { outputDirectory, width, height, durationMs };
}

function hasFixtureArgumentCount(count: number): boolean {
  return count === 6 || count === 8;
}

function readRequiredFixtureOption(values: readonly string[], index: number, expectedName: string): string {
  if (values[index] !== expectedName) throwFixtureUsage();
  const value = values[index + 1];
  if (value === undefined) throwFixtureUsage();
  return value;
}

function parseFixtureDuration(values: readonly string[]): number {
  if (values.length === 6) return 3_000;
  if (values[6] !== "--duration-ms") throwFixtureUsage();
  return Number(values[7]);
}

function validateFixtureArguments(outputDirectory: string, width: number, height: number, durationMs: number): void {
  if (!isValidFixtureDuration(durationMs)) throw new TypeError("recording renderer fixture duration is invalid");
  if (!isAbsolute(outputDirectory)) throw new TypeError("recording renderer fixture arguments are invalid");
  if (!hasValidFixtureDimensions(width, height)) throw new TypeError("recording renderer fixture arguments are invalid");
}

function hasValidFixtureDimensions(width: number, height: number): boolean {
  return isValidFixtureDimension(width, 3_840) && isValidFixtureDimension(height, 2_160);
}

function isValidFixtureDuration(durationMs: number): boolean {
  return Number.isSafeInteger(durationMs) && durationMs >= 3_000 && durationMs <= 120_000;
}

function isValidFixtureDimension(value: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && isEvenDimensionInRange(value, maximum);
}

function isEvenDimensionInRange(value: number, maximum: number): boolean {
  return value % 2 === 0 && value >= 2 && value <= maximum;
}

function throwFixtureUsage(): never {
  throw new TypeError("usage: recording-renderer-fixture --output <absolute-path> --width <width> --height <height> [--duration-ms <3000-120000>]");
}

main().catch((error: unknown) => {
  process.stderr.write(`recording-renderer-fixture: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
