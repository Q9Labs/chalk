import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { deriveRecordingMediaSourceId, parseRecordingPresentationTimelineV1, type RecordingMediaSourceV1, type RecordingPresentationAssetV1, type RecordingPresentationEventV1, type RecordingPresentationParticipantV1, type RecordingPresentationReactionV1 } from "@q9labsai/recording-presentation";
import { parseDecodedMediaIndexV1 } from "./decoded-media.js";
import { isMainModule } from "./node/main-module.js";

// A heavy Episode for the native compositor: three cameras, speaker changes,
// a screen share with a gap, two whiteboard revisions, reactions, a raised
// hand, a camera turning off, and a late joiner. Dev and benchmark use only.

const RECORDING_ID = "00000000-0000-4000-8000-000000000201";
const EPISODE_ID = "00000000-0000-4000-8000-000000000202";
const SPACE_ID = "00000000-0000-4000-8000-000000000203";
const ORIGIN_AUTHORITY_ID = "00000000-0000-4000-8000-000000000204";
const PEOPLE = [
  { id: "00000000-0000-4000-8000-000000000211", name: "Avery Chen", hue: 0 },
  { id: "00000000-0000-4000-8000-000000000212", name: "Morgan Diaz", hue: 120 },
  { id: "00000000-0000-4000-8000-000000000213", name: "Riley Okafor", hue: 240 },
] as const;
const LATE_JOINER = { id: "00000000-0000-4000-8000-000000000214", name: "Jordan Park" };
const REACTIONS: readonly RecordingPresentationReactionV1["value"][] = ["👍", "🎉", "❤️", "😂", "😮"];

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

async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const duration = args.durationMs;
  const at = (fraction: number): number => Math.round(duration * fraction);
  const { assetsDirectory, mediaDirectory } = await createFixtureDirectories(args.outputDirectory);

  const screenStart = at(0.2);
  const screenEnd = at(0.5);
  await prepareMedia(args, mediaDirectory, screenEnd - screenStart);

  const cameras = await Promise.all(
    PEOPLE.map(async (person, index) => ({
      person,
      file: `cam${index + 1}.webm`,
      source: await sourceFor(person.id, "camera", `camera-${index + 1}`),
    })),
  );
  const screen = { file: "screen.webm", source: await sourceFor(PEOPLE[1].id, "screen_share", "screen-1") };

  const assets: RecordingPresentationAssetV1[] = [];
  const addAsset = async (id: string, kind: RecordingPresentationAssetV1["kind"], contentType: string, bytes: Buffer): Promise<string> => {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    await writeFile(join(assetsDirectory, sha256), bytes, { flag: "wx", mode: 0o600 });
    assets.push({ id, kind, objectKey: `fixture/${id}`, contentType, byteSize: bytes.byteLength, sha256 });
    return id;
  };
  const whiteboardOne = await addAsset("whiteboard-state-1", "whiteboard_state", "application/json", whiteboardState(1));
  const whiteboardTwo = await addAsset("whiteboard-state-2", "whiteboard_state", "application/json", whiteboardState(2));

  const participant = (id: string, displayName: string, joinOrdinal: number, overrides: Partial<RecordingPresentationParticipantV1> = {}): RecordingPresentationParticipantV1 => ({
    id,
    displayName,
    joinOrdinal,
    joined: true,
    microphoneMuted: false,
    cameraEnabled: true,
    screenShareEnabled: false,
    speaking: false,
    activeSpeaker: false,
    handRaised: false,
    ...overrides,
  });

  const events: Omit<RecordingPresentationEventV1, "sequence">[] = [];
  const push = (event: Omit<RecordingPresentationEventV1, "sequence">): void => {
    events.push(event);
  };
  // The active speaker rotates every four seconds.
  let previousSpeaker: string = PEOPLE[0].id;
  for (let atMs = 4_000, turn = 1; atMs < duration; atMs += 4_000, turn += 1) {
    const speaker = PEOPLE[turn % PEOPLE.length]!.id;
    push({ atMs, kind: "participant_speaking_changed", participantId: previousSpeaker, speaking: false } as RecordingPresentationEventV1);
    push({ atMs, kind: "participant_speaking_changed", participantId: speaker, speaking: true } as RecordingPresentationEventV1);
    push({ atMs, kind: "active_speaker_changed", participantId: speaker } as RecordingPresentationEventV1);
    previousSpeaker = speaker;
  }
  for (let atMs = 15_000, index = 0; atMs < duration; atMs += 30_000, index += 1) {
    const person = PEOPLE[index % PEOPLE.length]!;
    push({ atMs, kind: "reaction_added", reaction: { id: `reaction-${index}`, participantId: person.id, displayName: person.name, value: REACTIONS[index % REACTIONS.length]!, occurredAtMs: atMs, expiresAtMs: Math.min(duration, atMs + 4_000) } } as RecordingPresentationEventV1);
  }
  push({ atMs: screenStart, kind: "participant_screen_share_changed", participantId: PEOPLE[1].id, enabled: true } as RecordingPresentationEventV1);
  push({ atMs: screenStart, kind: "media_source_changed", source: { ...screen.source, visible: true } } as RecordingPresentationEventV1);
  push({ atMs: screenStart, kind: "shared_content_changed", sharedContent: { kind: "screen_share", participantId: PEOPLE[1].id, sourceId: screen.source.sourceId } } as RecordingPresentationEventV1);
  push({ atMs: screenEnd, kind: "shared_content_changed", sharedContent: { kind: "whiteboard", sceneId: "scene-1", revision: 1, stateAssetId: whiteboardOne } } as RecordingPresentationEventV1);
  push({ atMs: screenEnd, kind: "participant_screen_share_changed", participantId: PEOPLE[1].id, enabled: false } as RecordingPresentationEventV1);
  push({ atMs: screenEnd, kind: "media_source_changed", source: { ...screen.source, visible: false } } as RecordingPresentationEventV1);
  push({ atMs: at(0.6), kind: "shared_content_changed", sharedContent: { kind: "whiteboard", sceneId: "scene-1", revision: 2, stateAssetId: whiteboardTwo } } as RecordingPresentationEventV1);
  push({ atMs: at(0.75), kind: "shared_content_changed", sharedContent: { kind: "none" } } as RecordingPresentationEventV1);
  push({ atMs: at(0.75), kind: "participant_camera_changed", participantId: PEOPLE[2].id, enabled: false } as RecordingPresentationEventV1);
  push({ atMs: at(0.75), kind: "media_source_changed", source: { ...cameras[2]!.source, visible: false } } as RecordingPresentationEventV1);
  push({ atMs: at(0.7), kind: "participant_hand_raised_changed", participantId: PEOPLE[1].id, raised: true } as RecordingPresentationEventV1);
  push({ atMs: at(0.85), kind: "participant_hand_raised_changed", participantId: PEOPLE[1].id, raised: false } as RecordingPresentationEventV1);
  push({ atMs: at(0.8), kind: "participant_joined", participant: participant(LATE_JOINER.id, LATE_JOINER.name, 4, { cameraEnabled: false, microphoneMuted: true }) } as RecordingPresentationEventV1);
  const orderedEvents = events.sort((left, right) => left.atMs - right.atMs).map((event, index) => ({ ...event, sequence: index + 1 }) as RecordingPresentationEventV1);

  const timeline = parseRecordingPresentationTimelineV1({
    schemaVersion: "recording_presentation.v1",
    recordingId: RECORDING_ID,
    episodeId: EPISODE_ID,
    clock: { origin: "capture_ready", timebase: "recording_relative_ms", captureEpoch: 1, originAuthorityId: ORIGIN_AUTHORITY_ID, durationMs: duration },
    sourceCursors: { episodeControlStartRevision: 1, episodeControlEndRevision: 2, chatStartSequence: 0, chatEndSequence: 0, whiteboardStartRevision: 0, whiteboardEndRevision: 2, capturePlanStartRevision: 1, capturePlanEndRevision: 2 },
    initial: {
      elapsedMs: 0,
      profile: {
        name: "recording-space",
        version: "recording-space.v1",
        viewport: { width: args.width, height: args.height, deviceScaleFactor: 1 },
        locale: "en",
        timeZone: "UTC",
        fontAssetIds: [],
        theme: { colorScheme: args.colorScheme, skin: "classic", palette: args.colorScheme === "dark" ? "warm-charcoal" : "light", texture: "none", stageBackground: true, generatedAvatars: true },
      },
      space: { id: SPACE_ID, name: "Weekly design review" },
      view: { layout: "grid", sidebar: "chat" },
      participants: PEOPLE.map((person, index) => participant(person.id, person.name, index + 1, { speaking: index === 0, activeSpeaker: index === 0, microphoneMuted: index === 2 })),
      media: [...cameras.map((camera) => ({ ...camera.source, visible: true })), { ...screen.source, visible: false }],
      chat: { retainedFloorSequence: null, headSequence: 0, messages: [] },
      sharedContent: { kind: "none" },
      reactions: [],
    },
    events: orderedEvents,
    assets,
  });

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
  const decodedMedia = {
    schema_version: "decoded_media.v1",
    recording_id: RECORDING_ID,
    episode_id: EPISODE_ID,
    clock: { origin: "capture_ready", timebase: "recording_relative_ms", origin_authority_id: ORIGIN_AUTHORITY_ID, capture_epoch: 1, duration_ms: duration },
    sources: [...(await Promise.all(cameras.map((camera) => sourceEntry(camera.source, camera.file, 0, duration)))), await sourceEntry(screen.source, screen.file, screenStart, screenEnd)],
    mix: { path: "mix.wav", codec: "pcm_s16le", container: "wav", content_type: "audio/wav", sample_rate_hz: 48_000, channels: 2, byte_size: mixFacts.byteSize, sha256: mixFacts.sha256, start_ms: 0, end_ms: duration },
    discontinuities: [{ source_id: screen.source.sourceId, track_id: screen.source.trackId, track_epoch: 1, start_ms: at(0.4), end_ms: at(0.42), reason: "source_gap" }],
  };
  parseDecodedMediaIndexV1(decodedMedia);

  const { presentationPath, decodedMediaPath, presentationFacts, decodedFacts } = await writeInputs(args.outputDirectory, mediaDirectory, timeline, decodedMedia);
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

async function writeInputs(outputDirectory: string, mediaDirectory: string, timeline: unknown, decodedMedia: unknown) {
  const [presentationPath, decodedMediaPath] = [join(outputDirectory, "recording-presentation.json"), join(mediaDirectory, "decoded-media.json")];
  await writeJSON(presentationPath, timeline);
  await writeJSON(decodedMediaPath, decodedMedia);
  const [presentationFacts, decodedFacts] = await Promise.all([fileFacts(presentationPath), fileFacts(decodedMediaPath)]);
  return { presentationPath, decodedMediaPath, presentationFacts, decodedFacts };
}

/** Copies prepared media when given, otherwise encodes VP8 test sources the way LiveKit egress would: default keyframe spacing. */
async function prepareMedia(args: FixtureArguments, mediaDirectory: string, screenDurationMs: number): Promise<void> {
  const files = ["cam1.webm", "cam2.webm", "cam3.webm", "screen.webm", "mix.wav"];
  if (args.mediaDirectory !== undefined) {
    for (const file of files) await copyFile(join(args.mediaDirectory, file), join(mediaDirectory, file));
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

function whiteboardState(revision: 1 | 2): Buffer {
  const base = { angle: 0, strokeColor: "#1e1e1e", strokeWidth: 2, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, boundElements: null, updated: 1, link: null, locked: false, backgroundColor: "transparent", fillStyle: "solid", roundness: null };
  const text = (id: string, index: string, x: number, y: number, value: string, fontSize: number) => ({
    id,
    index,
    payload: { ...base, x, y, width: value.length * fontSize * 0.55, height: fontSize * 1.25, seed: 7, text: value, originalText: value, fontSize, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25 },
    type: "text",
  });
  const elements = [
    { id: "box-1", index: "a0", type: "rectangle", payload: { ...base, x: 40, y: 80, width: 320, height: 180, backgroundColor: "#a5d8ff", fillStyle: "hachure", roundness: { type: 3 }, seed: 1 } },
    text("title", "a1", 40, 10, "Q3 onboarding flow", 36),
    text("box-1-label", "a2", 70, 150, "Sign up", 28),
    {
      id: "arrow-1",
      index: "a3",
      type: "arrow",
      payload: {
        ...base,
        x: 370,
        y: 170,
        width: 180,
        height: 0,
        seed: 3,
        points: [
          [0, 0],
          [180, 0],
        ],
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: null,
        endArrowhead: "arrow",
        elbowed: false,
      },
    },
    { id: "box-2", index: "a4", type: "ellipse", payload: { ...base, x: 560, y: 80, width: 260, height: 180, backgroundColor: "#ffc9c9", seed: 4 } },
    text("box-2-label", "a5", 610, 150, "First call", 28),
    ...(revision === 2
      ? [{ id: "note", index: "a6", type: "diamond", payload: { ...base, x: 300, y: 330, width: 260, height: 160, backgroundColor: "#b2f2bb", fillStyle: "cross-hatch", seed: 5 } }, text("note-label", "a7", 345, 395, "Invite team?", 24), text("emoji", "a8", 600, 400, "Ship it 🚀", 28)]
      : []),
  ].map((element) => ({ id: element.id, type: element.type, version: revision, version_nonce: revision, index: element.index, is_deleted: false, payload: element.payload }));
  return Buffer.from(JSON.stringify({ schemaVersion: "recording_whiteboard_state.v1", sceneId: "scene-1", revision, appState: {}, elements }));
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
