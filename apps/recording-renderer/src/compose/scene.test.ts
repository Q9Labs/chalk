import type { RecordingPresentationEventV1, RecordingPresentationParticipantV1, RecordingPresentationTimelineV1 } from "@q9labsai/recording-presentation";
import { describe, expect, it } from "vitest";
import type { DecodedMediaIndexV1 } from "../decoded-media.js";
import { buildSceneSpans, frameCountFor, frameTimeMs, groupVideoSegments, sceneFor, type SceneSpan } from "./scene.js";

const participant: RecordingPresentationParticipantV1 = {
  id: "avery",
  displayName: "Avery Chen",
  joinOrdinal: 1,
  joined: true,
  microphoneMuted: false,
  cameraEnabled: true,
  screenShareEnabled: false,
  speaking: false,
  activeSpeaker: false,
  handRaised: false,
};
const sourceId = `rps_${"0".repeat(64)}`;
const source = { sourceId, participantId: "avery", participantGeneration: 1, trackId: "track", trackEpoch: 1, kind: "camera", codec: "vp8", container: "webm", contentType: "video/webm", path: "cam.webm", byteSize: 1, sha256: "0".repeat(64), startMs: 5_000, endMs: 7_000 } as const;
const reaction = { id: "reaction", participantId: "avery", displayName: "Avery Chen", value: "👍", occurredAtMs: 2_000, expiresAtMs: 3_000 } as const;
const message = { id: "chat", sequence: 1, participantId: "avery", displayName: "Avery Chen", text: "Hello", createdAtMs: 4_000, displayTime: "00:04", attachments: [] } as const;

function timeline(events: readonly RecordingPresentationEventV1[] = []): RecordingPresentationTimelineV1 {
  return {
    schemaVersion: "recording_presentation.v1",
    recordingId: "recording",
    episodeId: "episode",
    clock: { origin: "capture_ready", timebase: "recording_relative_ms", captureEpoch: 1, originAuthorityId: "authority", durationMs: 8_000 },
    sourceCursors: { episodeControlStartRevision: 1, episodeControlEndRevision: 1, chatStartSequence: 0, chatEndSequence: 1, whiteboardStartRevision: 0, whiteboardEndRevision: 0, capturePlanStartRevision: 1, capturePlanEndRevision: 1 },
    initial: {
      elapsedMs: 0,
      profile: {
        name: "test",
        version: "recording-space.v1",
        uiBuildSha256: "0".repeat(64),
        viewport: { width: 1280, height: 720, deviceScaleFactor: 1 },
        locale: "en",
        timeZone: "UTC",
        fontAssetIds: [],
        theme: { colorScheme: "light", skin: "classic", palette: "light", texture: "none", stageBackground: true, generatedAvatars: true },
      },
      space: { id: "space", name: "Review" },
      view: { layout: "grid", sidebar: "chat" },
      participants: [participant],
      media: [{ sourceId, participantId: "avery", participantGeneration: 1, kind: "camera", trackId: "track", epoch: 1, visible: true }],
      chat: { retainedFloorSequence: null, headSequence: 0, messages: [] },
      sharedContent: { kind: "none" },
      reactions: [],
    },
    events,
    assets: [],
  };
}

function media(): DecodedMediaIndexV1 {
  return {
    schemaVersion: "decoded_media.v1",
    recordingId: "recording",
    episodeId: "episode",
    clock: { origin: "capture_ready", timebase: "recording_relative_ms", originAuthorityId: "authority", captureEpoch: 1, durationMs: 8_000 },
    sources: [source],
    mix: { path: "mix.wav", codec: "pcm_s16le", container: "wav", contentType: "audio/wav", sampleRateHz: 48_000, channels: 2, byteSize: 1, sha256: "0".repeat(64), startMs: 0, endMs: 8_000 },
    discontinuities: [{ sourceId, trackId: "track", trackEpoch: 1, startMs: 6_000, endMs: 6_500, reason: "source_gap" }],
  };
}

describe("scene spans", () => {
  it("rounds the frame count up and frame times down", () => {
    expect(frameCountFor(1_001, 15)).toBe(16);
    expect(frameTimeMs(1, 15)).toBe(66);
    expect(frameTimeMs(15, 15)).toBe(1_000);
  });

  it("merges nonvisual events but splits at visual events, expiry, media edges, and gaps", () => {
    const events: readonly RecordingPresentationEventV1[] = [
      { atMs: 1_000, sequence: 1, kind: "participant_hand_raised_changed", participantId: "avery", raised: true },
      { atMs: 2_000, sequence: 2, kind: "reaction_added", reaction },
      { atMs: 4_000, sequence: 3, kind: "chat_message_added", message },
    ];
    const spans = buildSceneSpans(timeline(events), media(), 10, { width: 1280, height: 720 });
    expect(spans.map(({ startFrame, endFrame }) => [startFrame, endFrame])).toEqual([
      [0, 10],
      [10, 20],
      [20, 30],
      [30, 50],
      [50, 60],
      [60, 65],
      [65, 70],
      [70, 80],
    ]);
    expect(spans[2]?.scene.reactions).toHaveLength(1);
    expect(spans[3]?.scene.reactions).toHaveLength(0);
    expect(spans.map((span) => span.scene.tiles.some((tile) => tile.kind !== "whiteboard" && tile.video !== undefined))).toEqual([false, false, false, false, true, false, true, false]);
  });

  it("groups neighboring scenes only while their video placements match", () => {
    const spans = buildSceneSpans(timeline(), media(), 10, { width: 1280, height: 720 });
    const split: readonly SceneSpan[] = spans.flatMap((span) =>
      span.startFrame === 0
        ? [
            { ...span, endFrame: 10 },
            { ...span, startFrame: 10 },
          ]
        : [span],
    );
    const segments = groupVideoSegments(split);
    expect(segments.map(({ startFrame, endFrame, placements }) => [startFrame, endFrame, placements.length])).toEqual([
      [0, 50, 0],
      [50, 60, 1],
      [60, 65, 0],
      [65, 70, 1],
      [70, 80, 0],
    ]);
    expect(segments[0]?.spans).toHaveLength(2);
  });

  it("uses distinct geometry for grid and presentation layouts", () => {
    const base = timeline().initial;
    const second = { ...participant, id: "morgan", displayName: "Morgan Diaz", joinOrdinal: 2 };
    const snapshot = { ...base, participants: [participant, second] };
    const grid = sceneFor(snapshot, () => false, { width: 1280, height: 720 });
    const presentation = sceneFor({ ...snapshot, view: { layout: "presentation", sidebar: "chat" } }, () => false, { width: 1280, height: 720 });
    expect(grid.tiles).toHaveLength(2);
    expect(presentation.tiles).toHaveLength(2);
    expect(presentation.tiles.map((tile) => tile.rect)).not.toEqual(grid.tiles.map((tile) => tile.rect));
  });
});
