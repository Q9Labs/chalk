import { choosePrimary, DEFAULT_GRID_OPTIONS, DEFAULT_SPOTLIGHT_OPTIONS, fitGrid, fitSpotlight, screenShareItemId, WHITEBOARD_ITEM_ID, type Participant, type StageBox, type StageItem } from "@q9labsai/chalk-react/headless";
import { createRecordingPresentationCursor, type RecordingPresentationParticipantV1, type RecordingPresentationSnapshotV1, type RecordingPresentationTimelineV1 } from "@q9labsai/recording-presentation";
import type { DecodedMediaIndexV1, DecodedVisualSourceV1 } from "../decoded-media.js";

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface SceneParticipant {
  readonly id: string;
  readonly displayName: string;
  readonly microphoneMuted: boolean;
  readonly handRaised: boolean;
  readonly speaking: boolean;
  readonly avatarAssetId?: string;
}

export type VideoFit = "cover" | "contain";

export interface SceneVideo {
  readonly sourceId: string;
  readonly fit: VideoFit;
}

export type SceneTile =
  | { readonly kind: "participant"; readonly rect: Rect; readonly participant: SceneParticipant; readonly video?: SceneVideo }
  | { readonly kind: "screen_share"; readonly rect: Rect; readonly participant: SceneParticipant; readonly video?: SceneVideo }
  | { readonly kind: "whiteboard"; readonly rect: Rect; readonly stateAssetId: string };

export interface SceneReaction {
  readonly value: string;
  readonly displayName: string;
}

/** Everything the painter draws for a span of frames. Equal scenes paint identically. */
export interface Scene {
  readonly spaceName: string;
  readonly logoAssetId?: string;
  readonly colorScheme: "light" | "dark";
  readonly generatedAvatars: boolean;
  readonly tiles: readonly SceneTile[];
  readonly reactions: readonly SceneReaction[];
}

/** Frames [startFrame, endFrame) share one scene. */
export interface SceneSpan {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly sceneKey: string;
  readonly scene: Scene;
}

export interface VideoPlacement {
  readonly sourceId: string;
  readonly rect: Rect;
  readonly fit: VideoFit;
}

/** Frames [startFrame, endFrame) share one video placement, so one FFmpeg run can compose them. */
export interface VideoSegment {
  readonly startFrame: number;
  readonly endFrame: number;
  readonly placements: readonly VideoPlacement[];
  readonly spans: readonly SceneSpan[];
}

export interface SceneLayout {
  readonly width: number;
  readonly height: number;
}

const FIRST_FRAME_HOLD_MS = 2_000;
const HEADER_HEIGHT = 48;
const STAGE_MARGIN = 16;

export function frameCountFor(durationMs: number, fps: number): number {
  return Math.ceil((durationMs * fps) / 1_000);
}

export function frameTimeMs(frame: number, fps: number): number {
  return Math.floor((frame * 1_000) / fps);
}

/**
 * One forward pass over the timeline. Every instant where the picture can
 * change becomes a frame boundary; between boundaries the scene is constant,
 * so each span is projected once instead of once per frame.
 */
export function buildSceneSpans(timeline: RecordingPresentationTimelineV1, media: DecodedMediaIndexV1, fps: number, layout: SceneLayout): readonly SceneSpan[] {
  const frameCount = frameCountFor(timeline.clock.durationMs, fps);
  const boundaries = changeFrames(timeline, media, fps, frameCount);
  const visualSources = new Map(media.sources.filter((source): source is DecodedVisualSourceV1 => source.kind !== "microphone").map((source) => [source.sourceId, source]));
  const cursor = createRecordingPresentationCursor(timeline);
  const spans: SceneSpan[] = [];
  for (const [index, startFrame] of boundaries.entries()) {
    const endFrame = boundaries[index + 1] ?? frameCount;
    const snapshot = cursor.at(frameTimeMs(startFrame, fps));
    const scene = sceneFor(snapshot, (sourceId) => videoAvailable(media, visualSources.get(sourceId), snapshot.elapsedMs), layout);
    const sceneKey = JSON.stringify(scene);
    appendSceneSpan(spans, { startFrame, endFrame, sceneKey, scene });
  }
  return spans;
}

function appendSceneSpan(spans: SceneSpan[], span: SceneSpan): void {
  const previous = spans.at(-1);
  if (previous?.sceneKey === span.sceneKey) spans[spans.length - 1] = { ...previous, endFrame: span.endFrame };
  else spans.push(span);
}

export function groupVideoSegments(spans: readonly SceneSpan[]): readonly VideoSegment[] {
  const segments: VideoSegment[] = [];
  let currentKey: string | undefined;
  for (const span of spans) {
    const placements = videoPlacements(span.scene);
    const key = JSON.stringify(placements);
    const current = segments.at(-1);
    if (current !== undefined && key === currentKey) {
      segments[segments.length - 1] = { ...current, endFrame: span.endFrame, spans: [...current.spans, span] };
    } else {
      segments.push({ startFrame: span.startFrame, endFrame: span.endFrame, placements, spans: [span] });
      currentKey = key;
    }
  }
  return segments;
}

function videoPlacements(scene: Scene): readonly VideoPlacement[] {
  const placements: VideoPlacement[] = [];
  for (const tile of scene.tiles) {
    if (tile.kind !== "whiteboard" && tile.video !== undefined) placements.push({ sourceId: tile.video.sourceId, rect: tile.rect, fit: tile.video.fit });
  }
  return placements;
}

function changeFrames(timeline: RecordingPresentationTimelineV1, media: DecodedMediaIndexV1, fps: number, frameCount: number): readonly number[] {
  const frames = new Set<number>();
  for (const time of changeTimes(timeline, media)) {
    const frame = Math.ceil((time * fps) / 1_000);
    if (frame >= 0 && frame < frameCount) frames.add(frame);
  }
  return [...frames].sort((left, right) => left - right);
}

function changeTimes(timeline: RecordingPresentationTimelineV1, media: DecodedMediaIndexV1): readonly number[] {
  const times = [0];
  for (const event of timeline.events) {
    times.push(event.atMs);
    if (event.kind === "reaction_added") times.push(event.reaction.expiresAtMs);
  }
  for (const reaction of timeline.initial.reactions) times.push(reaction.expiresAtMs);
  for (const source of media.sources) times.push(source.startMs, source.endMs);
  for (const gap of media.discontinuities) times.push(gap.startMs, gap.endMs);
  return times;
}

function videoAvailable(media: DecodedMediaIndexV1, source: DecodedVisualSourceV1 | undefined, elapsedMs: number): boolean {
  if (source === undefined || elapsedMs >= source.endMs) return false;
  // Only fill the recording's startup gap; timeline visibility still controls
  // later joins, camera toggles, and screen shares.
  if (elapsedMs < source.startMs) return source.startMs <= FIRST_FRAME_HOLD_MS;
  return !media.discontinuities.some((gap) => gap.sourceId === source.sourceId && gap.startMs <= elapsedMs && elapsedMs < gap.endMs);
}

/** Mirrors RecordingSpaceView's stage items and the live Stage's geometry, without the chat sidebar. */
export function sceneFor(snapshot: RecordingPresentationSnapshotV1, available: (sourceId: string) => boolean, layout: SceneLayout): Scene {
  const joined = snapshot.participants.filter((participant) => participant.joined).sort((left, right) => left.joinOrdinal - right.joinOrdinal || left.id.localeCompare(right.id));
  const byId = new Map(joined.map((participant) => [participant.id, participant]));
  const visibleMedia = snapshot.media.filter((source) => source.visible && byId.has(source.participantId));
  const cameraByParticipant = new Map(visibleMedia.filter((source) => source.kind === "camera").map((source) => [source.participantId, source.sourceId]));
  const items = stageItems(snapshot, joined, byId, visibleMedia);

  const stage: Rect = { x: STAGE_MARGIN, y: HEADER_HEIGHT, width: layout.width - STAGE_MARGIN * 2, height: layout.height - HEADER_HEIGHT - STAGE_MARGIN };
  const geometry = stageGeometry(items, snapshot.view.layout, stage);
  const itemsById = new Map(items.map((item) => [item.id, item]));
  const tiles: SceneTile[] = [];
  for (const frame of geometry.frames) {
    const item = itemsById.get(frame.id);
    if (item === undefined || frame.page !== 0) continue;
    const rect = evenRect({ x: stage.x + frame.x, y: stage.y + frame.y, width: frame.width, height: frame.height });
    const tile = sceneTile(item, rect, snapshot.sharedContent, byId, cameraByParticipant, available);
    if (tile !== undefined) tiles.push(tile);
  }

  const reactions = [...snapshot.reactions].sort((left, right) => left.occurredAtMs - right.occurredAtMs || left.id.localeCompare(right.id)).map((reaction) => ({ value: reaction.value, displayName: reaction.displayName }));
  return {
    spaceName: snapshot.space.name,
    ...(snapshot.space.logoAssetId === undefined ? {} : { logoAssetId: snapshot.space.logoAssetId }),
    colorScheme: snapshot.profile.theme.colorScheme,
    generatedAvatars: snapshot.profile.theme.generatedAvatars,
    tiles,
    reactions,
  };
}

function stageItems(snapshot: RecordingPresentationSnapshotV1, joined: readonly RecordingPresentationParticipantV1[], byId: ReadonlyMap<string, RecordingPresentationParticipantV1>, visibleMedia: RecordingPresentationSnapshotV1["media"]): StageItem[] {
  const items: StageItem[] = joined.map((participant) => ({ kind: "participant", id: participant.id, participant: stageParticipant(participant) }));
  const sharedContent = snapshot.sharedContent;
  if (sharedContent.kind === "screen_share") {
    const owner = byId.get(sharedContent.participantId);
    if (owner !== undefined && visibleMedia.some((source) => source.sourceId === sharedContent.sourceId)) items.push({ kind: "screen-share", id: screenShareItemId(owner.id), participant: stageParticipant(owner) });
  } else if (sharedContent.kind === "whiteboard") {
    items.push({ kind: "whiteboard", id: WHITEBOARD_ITEM_ID });
  }
  return items;
}

function stageGeometry(items: readonly StageItem[], layout: RecordingPresentationSnapshotV1["view"]["layout"], stage: Rect) {
  const box: StageBox = { width: stage.width, height: stage.height };
  const primary = layout === "grid" ? null : choosePrimary(items, { layout, pinnedId: null, lastSpeakerId: null, seenAt: new Map(items.map((item, index) => [item.id, index])) });
  return primary === null
    ? fitGrid(
        box,
        items.map((item) => item.id),
        DEFAULT_GRID_OPTIONS,
      )
    : fitSpotlight(
        box,
        primary.id,
        items.filter((item) => item.id !== primary.id).map((item) => item.id),
        DEFAULT_SPOTLIGHT_OPTIONS,
      );
}

function sceneTile(item: StageItem, rect: Rect, sharedContent: RecordingPresentationSnapshotV1["sharedContent"], byId: ReadonlyMap<string, RecordingPresentationParticipantV1>, cameraByParticipant: ReadonlyMap<string, string>, available: (sourceId: string) => boolean): SceneTile | undefined {
  if (item.kind === "whiteboard") return sharedContent.kind === "whiteboard" ? { kind: "whiteboard", rect, stateAssetId: sharedContent.stateAssetId } : undefined;
  const participant = byId.get(item.participant.id);
  if (participant === undefined) return undefined;
  if (item.kind === "screen-share") return screenShareTile(rect, participant, sharedContent, available);
  return cameraTile(rect, participant, cameraByParticipant, available);
}

function screenShareTile(rect: Rect, participant: RecordingPresentationParticipantV1, sharedContent: RecordingPresentationSnapshotV1["sharedContent"], available: (sourceId: string) => boolean): SceneTile {
  const sourceId = sharedContent.kind === "screen_share" ? sharedContent.sourceId : undefined;
  return { kind: "screen_share", rect, participant: sceneParticipant(participant), ...(sourceId !== undefined && available(sourceId) ? { video: { sourceId, fit: "contain" } } : {}) };
}

function cameraTile(rect: Rect, participant: RecordingPresentationParticipantV1, cameraByParticipant: ReadonlyMap<string, string>, available: (sourceId: string) => boolean): SceneTile {
  const cameraSourceId = cameraByParticipant.get(participant.id);
  const showsCamera = participant.cameraEnabled && cameraSourceId !== undefined && available(cameraSourceId);
  return { kind: "participant", rect, participant: sceneParticipant(participant), ...(showsCamera ? { video: { sourceId: cameraSourceId, fit: "cover" } } : {}) };
}

function stageParticipant(participant: RecordingPresentationParticipantV1): Participant {
  return {
    id: participant.id,
    displayName: participant.displayName,
    isSpeaking: participant.speaking,
    isActiveSpeaker: participant.activeSpeaker,
    isMuted: participant.microphoneMuted,
    isVideoEnabled: participant.cameraEnabled,
    isScreenSharing: participant.screenShareEnabled,
    isHandRaised: participant.handRaised,
  };
}

function sceneParticipant(participant: RecordingPresentationParticipantV1): SceneParticipant {
  return {
    id: participant.id,
    displayName: participant.displayName,
    microphoneMuted: participant.microphoneMuted,
    handRaised: participant.handRaised,
    speaking: participant.speaking || participant.activeSpeaker,
    ...(participant.avatarAssetId === undefined ? {} : { avatarAssetId: participant.avatarAssetId }),
  };
}

// 4:2:0 video has one chroma sample per 2×2 block, so tiles on even pixels line
// the video up exactly with the transparent hole the painter leaves for it.
function evenRect(rect: Rect): Rect {
  const x = even(rect.x);
  const y = even(rect.y);
  return { x, y, width: Math.max(2, even(rect.x + rect.width) - x), height: Math.max(2, even(rect.y + rect.height) - y) };
}

function even(value: number): number {
  return Math.round(value / 2) * 2;
}
