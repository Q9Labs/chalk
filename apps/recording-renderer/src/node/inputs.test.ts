import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deriveRecordingMediaSourceId, parseRecordingPresentationTimelineV1, type RecordingPresentationTimelineV1 } from "@q9labsai/recording-presentation";
import { describe, expect, it } from "vitest";
import { loadVerifiedRenderInputs } from "./inputs.js";

async function fixture() {
  const timeline = parseRecordingPresentationTimelineV1(JSON.parse(await readFile(new URL("../../../../contract/schema/fixtures/recording-presentation-v1/minimal-valid.json", import.meta.url), "utf8")));
  const identity = { recordingId: timeline.recordingId, participantId: "missing", participantGeneration: 1, kind: "camera", trackId: "missing-track", epoch: 1 } as const;
  const { recordingId: _recordingId, ...sourceIdentity } = identity;
  const missing = { ...sourceIdentity, sourceId: await deriveRecordingMediaSourceId(identity), visible: true };
  const presentIdentity = { ...identity, participantId: "present", trackId: "present-track" };
  const present = { ...sourceIdentity, participantId: presentIdentity.participantId, trackId: presentIdentity.trackId, sourceId: await deriveRecordingMediaSourceId(presentIdentity), visible: true };
  const participant = timeline.initial.participants[0];
  if (participant === undefined) throw new Error("fixture participant is missing");
  const presentation: RecordingPresentationTimelineV1 = {
    ...timeline,
    initial: {
      ...timeline.initial,
      participants: [
        { ...participant, id: "missing", joinOrdinal: 1 },
        { ...participant, id: "present", joinOrdinal: 2 },
      ],
      media: [missing, present],
    },
    events: [],
  };
  const bytes = Buffer.from("verified fixture media");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const decodedSource = {
    source_id: present.sourceId,
    participant_id: present.participantId,
    participant_generation: 1,
    track_id: present.trackId,
    track_epoch: 1,
    kind: "camera",
    codec: "vp8",
    container: "webm",
    content_type: "video/webm",
    path: "camera.webm",
    byte_size: bytes.length,
    sha256,
    start_ms: 0,
    end_ms: timeline.clock.durationMs,
  };
  const decoded = {
    schema_version: "decoded_media.v1",
    recording_id: timeline.recordingId,
    episode_id: timeline.episodeId,
    clock: { origin: "capture_ready", timebase: "recording_relative_ms", origin_authority_id: timeline.clock.originAuthorityId, capture_epoch: 1, duration_ms: timeline.clock.durationMs },
    sources: [decodedSource],
    mix: { path: "mix.wav", codec: "pcm_s16le", container: "wav", content_type: "audio/wav", sample_rate_hz: 48_000, channels: 2, byte_size: bytes.length, sha256, start_ms: 0, end_ms: timeline.clock.durationMs },
    discontinuities: [],
  };
  return { presentation, decoded, bytes, missing, present };
}

async function withInputs(data: Awaited<ReturnType<typeof fixture>>, check: (request: Parameters<typeof loadVerifiedRenderInputs>[0]) => Promise<void>) {
  const workspaceDirectory = await realpath(await mkdtemp(join(tmpdir(), "chalk-inputs-")));
  try {
    const assetDirectory = join(workspaceDirectory, "assets");
    await mkdir(assetDirectory);
    await writeFile(join(workspaceDirectory, "camera.webm"), data.bytes);
    await writeFile(join(workspaceDirectory, "mix.wav"), data.bytes);
    const presentationPath = join(workspaceDirectory, "presentation.json");
    const decodedMediaPath = join(workspaceDirectory, "decoded-media.json");
    const presentationBytes = JSON.stringify(data.presentation);
    const decodedBytes = JSON.stringify(data.decoded);
    await writeFile(presentationPath, presentationBytes);
    await writeFile(decodedMediaPath, decodedBytes);
    await check({
      schemaVersion: "recording-frame-render-request.v1",
      recordingId: data.presentation.recordingId,
      episodeId: data.presentation.episodeId,
      workspaceDirectory,
      presentationPath,
      presentationSha256: createHash("sha256").update(presentationBytes).digest("hex"),
      assetDirectory,
      decodedMediaPath,
      decodedMediaSha256: createHash("sha256").update(decodedBytes).digest("hex"),
      width: 1280,
      height: 720,
      fps: 15,
      durationMs: data.presentation.clock.durationMs,
    });
  } finally {
    await rm(workspaceDirectory, { recursive: true, force: true });
  }
}

describe("verified render source authority", () => {
  it.each(["camera", "microphone", "screen_share"] as const)("accepts an authenticated %s source without decoded media and preserves available video", async (kind) => {
    const data = await fixture();
    const missing = { ...data.missing, kind, visible: kind !== "microphone" };
    missing.sourceId = await deriveRecordingMediaSourceId({ ...missing, recordingId: data.presentation.recordingId });
    await withInputs({ ...data, presentation: { ...data.presentation, initial: { ...data.presentation.initial, media: [missing, data.present] } } }, async (request) => {
      const inputs = await loadVerifiedRenderInputs(request);
      expect(inputs.mediaFiles.has(missing.sourceId)).toBe(false);
      expect(inputs.mediaFiles.has(data.present.sourceId)).toBe(true);
      expect(inputs.timeline.initial.media).toContainEqual(missing);
    });
  });

  it("accepts a source introduced by a timeline event without decoded media", async () => {
    const data = await fixture();
    await withInputs({ ...data, presentation: { ...data.presentation, initial: { ...data.presentation.initial, media: [data.present] }, events: [{ atMs: 1000, sequence: 1, kind: "media_source_changed", source: data.missing }] } }, async (request) => {
      await expect(loadVerifiedRenderInputs(request)).resolves.toBeDefined();
    });
  });

  it.each([{ participant_id: "foreign" }, { participant_generation: 2 }, { track_id: "foreign-track" }, { track_epoch: 2 }, { kind: "screen_share" }])("rejects decoded media with mismatched identity %j", async (mismatch) => {
    const data = await fixture();
    data.decoded.sources = data.decoded.sources.map((source) => ({ ...source, ...mismatch }));
    await withInputs(data, async (request) => {
      await expect(loadVerifiedRenderInputs(request)).rejects.toThrow("has no authenticated decoded media");
    });
  });

  it("still authenticates the identity of a source without decoded media", async () => {
    const data = await fixture();
    await withInputs({ ...data, presentation: { ...data.presentation, initial: { ...data.presentation.initial, media: [{ ...data.missing, sourceId: `rps_${"0".repeat(64)}` }, data.present] } } }, async (request) => {
      await expect(loadVerifiedRenderInputs(request)).rejects.toThrow("has an invalid authenticated identity");
    });
  });
});
