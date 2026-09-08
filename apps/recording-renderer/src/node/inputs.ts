import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { deriveRecordingMediaSourceId, parseRecordingPresentationTimelineV1, type RecordingPresentationTimelineV1 } from "@q9labsai/recording-presentation";
import { parseDecodedMediaIndexV1, type DecodedMediaIndexV1 } from "../decoded-media.js";
import type { FrameRenderRequestV1 } from "./request.js";

const MAXIMUM_PRESENTATION_BYTES = 64 << 20;
const MAXIMUM_DECODED_INDEX_BYTES = 16 << 20;

export interface VerifiedFileBinding {
  readonly path: string;
  readonly contentType: string;
  readonly byteSize: number;
}

export interface VerifiedRenderInputs {
  readonly workspaceDirectory: string;
  readonly timeline: RecordingPresentationTimelineV1;
  readonly media: DecodedMediaIndexV1;
  readonly decodedMediaDocument: unknown;
  readonly assets: ReadonlyMap<string, VerifiedFileBinding>;
  readonly mediaFiles: ReadonlyMap<string, VerifiedFileBinding>;
}

export async function loadVerifiedRenderInputs(request: FrameRenderRequestV1): Promise<VerifiedRenderInputs> {
  const workspaceDirectory = await realpath(request.workspaceDirectory);
  const presentationPath = await confinedRealPath(workspaceDirectory, request.presentationPath);
  const decodedMediaPath = await confinedRealPath(workspaceDirectory, request.decodedMediaPath);
  const assetDirectory = await confinedRealPath(workspaceDirectory, request.assetDirectory);

  const presentationValue = await readVerifiedJson(presentationPath, request.presentationSha256, MAXIMUM_PRESENTATION_BYTES, "recording presentation");
  const decodedMediaValue = await readVerifiedJson(decodedMediaPath, request.decodedMediaSha256, MAXIMUM_DECODED_INDEX_BYTES, "decoded media index");
  const timeline = parseRecordingPresentationTimelineV1(presentationValue);
  const media = parseDecodedMediaIndexV1(decodedMediaValue);
  await validateSharedAuthority(request, timeline, media);

  const assets = new Map<string, VerifiedFileBinding>();
  for (const asset of timeline.assets) {
    const path = await confinedRealPath(assetDirectory, join(assetDirectory, asset.sha256));
    await verifyFileFacts(path, asset.byteSize, asset.sha256, `presentation asset ${asset.id}`);
    assets.set(asset.id, { path, contentType: asset.contentType, byteSize: asset.byteSize });
  }

  const mediaRoot = await realpath(dirname(decodedMediaPath));
  const mediaFiles = new Map<string, VerifiedFileBinding>();
  for (const source of media.sources) {
    const path = await confinedRealPath(mediaRoot, resolve(mediaRoot, source.path));
    await verifyFileFacts(path, source.byteSize, source.sha256, `decoded media source ${source.sourceId}`);
    mediaFiles.set(source.sourceId, { path, contentType: source.contentType, byteSize: source.byteSize });
  }
  const mixPath = await confinedRealPath(mediaRoot, resolve(mediaRoot, media.mix.path));
  await verifyFileFacts(mixPath, media.mix.byteSize, media.mix.sha256, "decoded audio mix");

  return { workspaceDirectory, timeline, media, decodedMediaDocument: decodedMediaValue, assets, mediaFiles };
}

async function validateSharedAuthority(request: FrameRenderRequestV1, timeline: RecordingPresentationTimelineV1, media: DecodedMediaIndexV1): Promise<void> {
  validateRecordingAuthority(request, timeline, media);
  validateClockAuthority(request, timeline, media);
  validateProfileAuthority(request, timeline);

  const decodedBySource = new Map(media.sources.map((source) => [source.sourceId, source]));
  const presentationSources = [...timeline.initial.media, ...timeline.events.flatMap((event) => (event.kind === "media_source_changed" ? [event.source] : []))];
  for (const source of presentationSources) {
    const decoded = decodedBySource.get(source.sourceId);
    validateDecodedSource(source, decoded);
    const expectedSourceId = await deriveRecordingMediaSourceId({
      recordingId: request.recordingId,
      participantId: source.participantId,
      participantGeneration: source.participantGeneration,
      kind: source.kind,
      trackId: source.trackId,
      epoch: source.epoch,
    });
    if (source.sourceId !== expectedSourceId) throw new TypeError(`recording presentation source ${source.sourceId} has an invalid authenticated identity`);
  }
}

function validateRecordingAuthority(request: FrameRenderRequestV1, timeline: RecordingPresentationTimelineV1, media: DecodedMediaIndexV1): void {
  validateSharedIdentifier(timeline.recordingId, media.recordingId, request.recordingId);
  validateSharedIdentifier(timeline.episodeId, media.episodeId, request.episodeId);
}

function validateSharedIdentifier(timelineValue: string, mediaValue: string, requestedValue: string): void {
  if (timelineValue !== requestedValue) throw new TypeError("render inputs do not match the requested Recording and Episode");
  if (mediaValue !== requestedValue) throw new TypeError("render inputs do not match the requested Recording and Episode");
}

function validateClockAuthority(request: FrameRenderRequestV1, timeline: RecordingPresentationTimelineV1, media: DecodedMediaIndexV1): void {
  const clocksMatch = [
    timeline.clock.origin === media.clock.origin,
    timeline.clock.timebase === media.clock.timebase,
    timeline.clock.originAuthorityId === media.clock.originAuthorityId,
    timeline.clock.captureEpoch === media.clock.captureEpoch,
    timeline.clock.durationMs === media.clock.durationMs,
  ].every(Boolean);
  if (!clocksMatch) throw new TypeError("recording presentation and decoded media clocks do not match");
  if (timeline.clock.durationMs !== request.durationMs) throw new TypeError("recording presentation and decoded media clocks do not match");
}

function validateProfileAuthority(request: FrameRenderRequestV1, timeline: RecordingPresentationTimelineV1): void {
  const viewport = timeline.initial.profile.viewport;
  if (viewport.width !== request.width) throw new TypeError("recording presentation profile does not match the renderer build or viewport");
  if (viewport.height !== request.height) throw new TypeError("recording presentation profile does not match the renderer build or viewport");
  if (timeline.initial.profile.uiBuildSha256 !== request.uiBuildSha256) throw new TypeError("recording presentation profile does not match the renderer build or viewport");
}

function validateDecodedSource(source: RecordingPresentationTimelineV1["initial"]["media"][number], decoded: DecodedMediaIndexV1["sources"][number] | undefined): void {
  if (decoded === undefined) throw new TypeError(`recording presentation source ${source.sourceId} has no authenticated decoded media`);
  const sourceMatches = [decoded.kind === source.kind, decoded.participantId === source.participantId, decoded.participantGeneration === source.participantGeneration, decoded.trackId === source.trackId, decoded.trackEpoch === source.epoch].every(Boolean);
  if (!sourceMatches) throw new TypeError(`recording presentation source ${source.sourceId} has no authenticated decoded media`);
}

async function readVerifiedJson(path: string, expectedSha256: string, maximumBytes: number, label: string): Promise<unknown> {
  await validateJsonFileFacts(path, maximumBytes, label);
  const sha256 = await hashFile(path);
  if (sha256 !== expectedSha256) throw new TypeError(`${label} checksum does not match its authority`);
  const bytes = await readFile(path);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new TypeError(`${label} is not valid JSON`, { cause: error });
  }
}

async function validateJsonFileFacts(path: string, maximumBytes: number, label: string): Promise<void> {
  const facts = await stat(path);
  if (!facts.isFile()) throw new TypeError(`${label} exceeds its byte bound`);
  if (facts.size < 1) throw new TypeError(`${label} exceeds its byte bound`);
  if (facts.size > maximumBytes) throw new TypeError(`${label} exceeds its byte bound`);
}

async function verifyFileFacts(path: string, expectedBytes: number, expectedSha256: string, label: string): Promise<void> {
  const facts = await stat(path);
  if (!facts.isFile() || facts.size !== expectedBytes) throw new TypeError(`${label} byte size does not match its authority`);
  if ((await hashFile(path)) !== expectedSha256) throw new TypeError(`${label} checksum does not match its authority`);
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function confinedRealPath(root: string, candidate: string): Promise<string> {
  const resolvedCandidate = await realpath(candidate);
  const pathFromRoot = relative(root, resolvedCandidate);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) throw new TypeError(`render input escapes its authorized root: ${candidate}`);
  return resolvedCandidate;
}
