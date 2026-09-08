import { parseRecordingPresentationTimelineV1, projectRecordingPresentation, type RecordingMediaSourceV1, type RecordingPresentationSnapshotV1, type RecordingSharedContentV1 } from "@q9labsai/recording-presentation";
import { RecordingSpaceView, RecordingWhiteboardView, loadRecordingWhiteboardFiles, parseRecordingWhiteboardStateV1, type RecordingWhiteboardStateV1 } from "@q9labsai/chalk-react";
import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { parseDecodedMediaIndexV1, type DecodedMediaIndexV1, type DecodedVisualSourceV1 } from "../decoded-media.js";
import type { RecordingRendererRuntime } from "../runtime-api.js";
import "./styles.css";

const rootElement = document.querySelector<HTMLElement>("#root");
if (rootElement === null) throw new Error("recording renderer root is absent");

const response = await fetch("/runtime/input", { cache: "no-store", credentials: "omit" });
if (!response.ok) throw new Error(`recording renderer input failed with ${response.status}`);
const input = parseRuntimeInput(await response.json());
const decodedMedia = parseDecodedMediaIndexV1(input.decodedMedia);
const timeline = parseRecordingPresentationTimelineV1(input.presentation);
const visualSources = new Map(decodedMedia.sources.filter((source): source is DecodedVisualSourceV1 => source.kind !== "microphone").map((source) => [source.sourceId, source]));
const whiteboards = new Map<string, PreparedWhiteboard>();
const whiteboardLoads = new Map<string, Promise<PreparedWhiteboard>>();
const reactRoot = createRoot(rootElement);

const runtime: RecordingRendererRuntime = {
  ready: true,
  async renderFrame(elapsedMs, token) {
    validateFrameRequest(elapsedMs, token);
    const frame = projectRecordingPresentation(timeline, elapsedMs);
    await prepareWhiteboard(frame);
    render(frame, undefined, undefined);
    await settleFrame(frame, decodedMedia);
    const whiteboardPresentation = presentedWhiteboard(frame);
    render(frame, token, whiteboardPresentation);
    await Promise.all([settleImages(), whiteboardPresentation?.promise]);
    await animationFrames(2);
    await document.fonts.ready;
    const rendered = document.querySelector<HTMLElement>("[data-recording-space-render-token]");
    if (rendered?.dataset.recordingSpaceRenderToken !== token) throw new Error("recording renderer did not acknowledge the frame token");
  },
};

window.chalkRecordingRenderer = runtime;

function validateFrameRequest(elapsedMs: number, token: string): void {
  if (!isValidFrameElapsedMs(elapsedMs) || !isValidFrameToken(token)) throw new RangeError("recording renderer frame request is invalid");
}

function isValidFrameElapsedMs(elapsedMs: number): boolean {
  return Number.isSafeInteger(elapsedMs) && elapsedMs >= 0 && elapsedMs <= timeline.clock.durationMs;
}

function isValidFrameToken(token: string): boolean {
  return token.length > 0 && token.length <= 256;
}

function render(frame: RecordingPresentationSnapshotV1, renderToken: string | undefined, whiteboardPresentation: WhiteboardPresentation | undefined): void {
  flushSync(() => {
    reactRoot.render(
      <RecordingSpaceView
        frame={frame}
        renderToken={renderToken}
        resolveAssetUrl={(assetId) => `/runtime/assets/${encodeURIComponent(assetId)}`}
        resolveMedia={(source) => resolveMedia(source, frame.elapsedMs)}
        renderWhiteboard={(sharedContent) => renderWhiteboard(sharedContent, frame, whiteboardPresentation)}
        className="recording-renderer-frame"
      />,
    );
  });
}

function resolveMedia(source: RecordingMediaSourceV1, elapsedMs: number): ReactNode {
  const decoded = visualSources.get(source.sourceId);
  if (decoded === undefined || unavailableAt(decodedMedia, decoded, elapsedMs)) return null;
  return <video data-recording-source={source.sourceId} data-recording-target-ms={elapsedMs - decoded.startMs} src={`/runtime/media/${encodeURIComponent(source.sourceId)}`} muted playsInline preload="auto" />;
}

function renderWhiteboard(sharedContent: Extract<RecordingSharedContentV1, { readonly kind: "whiteboard" }>, frame: RecordingPresentationSnapshotV1, presentation: WhiteboardPresentation | undefined): ReactNode {
  const prepared = whiteboards.get(sharedContent.stateAssetId);
  if (prepared === undefined) throw new Error("recording whiteboard state was not prepared");
  return (
    <RecordingWhiteboardView
      state={prepared.state}
      files={prepared.files}
      expectedSceneId={sharedContent.sceneId}
      expectedRevision={sharedContent.revision}
      theme={frame.profile.theme.colorScheme}
      excalidrawCssPath="/excalidraw.css"
      onLoadError={presentation?.failed}
      onPresented={presentation?.presented}
    />
  );
}

interface PreparedWhiteboard {
  readonly state: RecordingWhiteboardStateV1;
  readonly files: Awaited<ReturnType<typeof loadRecordingWhiteboardFiles>>;
}

async function prepareWhiteboard(frame: RecordingPresentationSnapshotV1): Promise<void> {
  if (frame.sharedContent.kind !== "whiteboard" || whiteboards.has(frame.sharedContent.stateAssetId)) return;
  const assetId = frame.sharedContent.stateAssetId;
  let pending = whiteboardLoads.get(assetId);
  if (pending === undefined) {
    pending = loadWhiteboard(assetId);
    whiteboardLoads.set(assetId, pending);
  }
  const prepared = await pending;
  whiteboards.set(assetId, prepared);
}

async function loadWhiteboard(stateAssetId: string): Promise<PreparedWhiteboard> {
  const response = await fetch(assetURL(stateAssetId), { cache: "no-store", credentials: "omit" });
  if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) throw new Error("recording whiteboard state asset is unavailable");
  const state = parseRecordingWhiteboardStateV1(await response.json());
  const files = await loadRecordingWhiteboardFiles(state, async ({ assetId }) => {
    const fileResponse = await fetch(assetURL(assetId), { cache: "no-store", credentials: "omit" });
    if (!fileResponse.ok) throw new Error(`recording whiteboard file asset is unavailable: ${assetId}`);
    const mimeType = fileResponse.headers.get("content-type") ?? "";
    return { mimeType, dataURL: await blobDataURL(await fileResponse.blob()), createdAtMs: 0 };
  });
  return { state, files };
}

function assetURL(assetId: string): string {
  return `/runtime/assets/${encodeURIComponent(assetId)}`;
}

async function blobDataURL(blob: Blob): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new TypeError("recording whiteboard file data URL is invalid"));
    });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("recording whiteboard file could not be read")));
    reader.readAsDataURL(blob);
  });
}

interface WhiteboardPresentation {
  readonly promise: Promise<void>;
  readonly presented: () => void;
  readonly failed: (error: Error) => void;
}

function presentedWhiteboard(frame: RecordingPresentationSnapshotV1): WhiteboardPresentation | undefined {
  if (frame.sharedContent.kind !== "whiteboard") return undefined;
  let presented = (): void => {};
  let failed = (_error: Error): void => {};
  const promise = new Promise<void>((resolve, reject) => {
    presented = resolve;
    failed = reject;
  });
  return { promise, presented, failed };
}

function unavailableAt(media: DecodedMediaIndexV1, source: DecodedVisualSourceV1, elapsedMs: number): boolean {
  if (elapsedMs < source.startMs || elapsedMs >= source.endMs) return true;
  return media.discontinuities.some((gap) => gap.sourceId === source.sourceId && gap.startMs <= elapsedMs && elapsedMs < gap.endMs);
}

async function settleFrame(frame: RecordingPresentationSnapshotV1, media: DecodedMediaIndexV1): Promise<void> {
  const videos = [...document.querySelectorAll<HTMLVideoElement>("video[data-recording-source]")];
  await Promise.all(videos.map((video) => seekVideo(video, frame, media)));
  await settleImages();
  await document.fonts.ready;
}

async function seekVideo(video: HTMLVideoElement, frame: RecordingPresentationSnapshotV1, media: DecodedMediaIndexV1): Promise<void> {
  const targetMs = readVideoTargetMs(video, frame, media);
  video.pause();
  const targetSeconds = targetMs / 1_000;
  let presented = presentedFrameIfPending(video, targetSeconds);
  await ensureMediaReadyState(video, HTMLMediaElement.HAVE_METADATA, "loadedmetadata");
  if (Math.abs(video.currentTime - targetSeconds) > 0.000_5) {
    presented ??= presentedVideoFrame(video, targetSeconds);
    video.currentTime = targetSeconds;
    await mediaEvent(video, "seeked");
  }
  await ensureMediaReadyState(video, HTMLMediaElement.HAVE_CURRENT_DATA, "loadeddata");
  await presented;
}

function presentedFrameIfPending(video: HTMLVideoElement, targetSeconds: number): Promise<void> | undefined {
  return video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ? presentedVideoFrame(video, targetSeconds) : undefined;
}

async function ensureMediaReadyState(video: HTMLVideoElement, readyState: number, event: string): Promise<void> {
  if (video.readyState < readyState) await mediaEvent(video, event);
}

function readVideoTargetMs(video: HTMLVideoElement, frame: RecordingPresentationSnapshotV1, media: DecodedMediaIndexV1): number {
  const sourceId = video.dataset.recordingSource;
  if (sourceId === undefined) throwInvalidVideoBinding();
  const source = findVisualSource(media, sourceId);
  const targetText = video.dataset.recordingTargetMs;
  if (targetText === undefined) throwInvalidVideoBinding();
  const targetMs = Number(targetText);
  if (!isValidVideoTarget(targetMs, frame.elapsedMs, source.startMs)) throwInvalidVideoBinding();
  return targetMs;
}

function findVisualSource(media: DecodedMediaIndexV1, sourceId: string): DecodedVisualSourceV1 {
  const source = media.sources.find((candidate) => candidate.sourceId === sourceId);
  if (source === undefined) throwInvalidVideoBinding();
  if (source.kind === "microphone") throwInvalidVideoBinding();
  return source;
}

function isValidVideoTarget(targetMs: number, elapsedMs: number, sourceStartMs: number): boolean {
  return Number.isSafeInteger(targetMs) && targetMs >= 0 && elapsedMs - sourceStartMs === targetMs;
}

function throwInvalidVideoBinding(): never {
  throw new Error("recording renderer video is not bound to its frame clock");
}

async function presentedVideoFrame(video: HTMLVideoElement, targetSeconds: number): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== "function") {
    await animationFrames(2);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    let callbackId = 0;
    let deadlineFrameId = 0;
    let deadlineFrames = 0;
    let settled = false;
    const cleanup = (): void => {
      video.removeEventListener("error", failed);
      video.cancelVideoFrameCallback(callbackId);
      cancelAnimationFrame(deadlineFrameId);
    };
    const succeed = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const failed = (): void => {
      fail(new Error("recording renderer video failed before frame presentation"));
    };
    const presented = (_now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata): void => {
      if (Math.abs(metadata.mediaTime - targetSeconds) <= 0.05) succeed();
      else callbackId = video.requestVideoFrameCallback(presented);
    };
    const deadline = (): void => {
      deadlineFrames += 1;
      if (deadlineFrames >= 120) fail(new Error("recording renderer timed out waiting for decoded video frame presentation"));
      else deadlineFrameId = requestAnimationFrame(deadline);
    };
    video.addEventListener("error", failed, { once: true });
    callbackId = video.requestVideoFrameCallback(presented);
    deadlineFrameId = requestAnimationFrame(deadline);
  });
}

async function animationFrames(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }
}

async function settleImages(): Promise<void> {
  await Promise.all(
    [...document.images].map(async (image) => {
      if (!image.complete) await mediaEvent(image, "load");
      await image.decode();
    }),
  );
}

function mediaEvent(target: HTMLElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      target.removeEventListener(event, success);
      target.removeEventListener("error", failure);
    };
    const success = (): void => {
      cleanup();
      resolve();
    };
    const failure = (): void => {
      cleanup();
      reject(new Error(`recording renderer media failed while waiting for ${event}`));
    };
    target.addEventListener(event, success, { once: true });
    target.addEventListener("error", failure, { once: true });
  });
}

function parseRuntimeInput(value: unknown): { readonly presentation: unknown; readonly decodedMedia: unknown } {
  assertRuntimeInputObject(value);
  const keys = Object.keys(value).sort();
  if (!hasRuntimeInputKeys(keys)) throw new TypeError("recording renderer runtime input has unexpected fields");
  return { presentation: Reflect.get(value, "presentation"), decodedMedia: Reflect.get(value, "decodedMedia") };
}

function assertRuntimeInputObject(value: unknown): asserts value is object {
  if (typeof value !== "object") throw new TypeError("recording renderer runtime input is invalid");
  if (value === null) throw new TypeError("recording renderer runtime input is invalid");
  if (Array.isArray(value)) throw new TypeError("recording renderer runtime input is invalid");
}

function hasRuntimeInputKeys(keys: readonly string[]): boolean {
  return keys.length === 2 && keys[0] === "decodedMedia" && keys[1] === "presentation";
}
