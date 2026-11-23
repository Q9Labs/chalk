import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { percentile } from "../../../features/scorecard/stats.mjs";
import { deriveRecordingMediaSourceId } from "../../../packages/recording-presentation/src/source-id.ts";
import { centroid, decodeRgb, fiducialPpm, inkPixel, regionAround, TARGETS, targetPixel } from "./pixels.mjs";

const renderer = fileURLToPath(new URL("../../../apps/recording-renderer/", import.meta.url));
const output = resolve(process.argv[2] ?? ".verify/screen-annotation-recording");
const fps = 30;
const width = 960;
const height = 540;
const startMs = 4000;
const endMs = 10_000;
const replacementMs = 8500;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const read = (file) => JSON.parse(readFileSync(file, "utf8"));
const write = (file, value) => {
  const data = JSON.stringify(value);
  writeFileSync(file, data, { mode: 0o600 });
  return hash(data);
};
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { encoding: "utf8", ...options });
const ffmpeg = (...args) => run("ffmpeg", ["-v", "error", "-nostdin", ...args]);

mkdirSync(dirname(output), { recursive: true });
const fixture = JSON.parse(run(process.execPath, [join(renderer, "dist/fixture/compose-fixture.js"), "--output", output, "--duration-ms", "20000", "--width", String(width), "--height", String(height), "--fps", String(fps)]));
const request = read(fixture.requestPath);
const timeline = read(request.presentation_path);
const media = read(request.decoded_media_path);
const source = media.sources.find((item) => item.kind === "screen_share");
const sharer = timeline.initial.participants.find((item) => item.id === source.participant_id);
const viewer = timeline.initial.participants.find((item) => item.id !== source.participant_id);
const layerId = "00000000-0000-4000-8000-000000000301";

const fiducial = join(output, "fiducial.ppm");
writeFileSync(fiducial, fiducialPpm(width, height));
const track = join(output, "media", "fiducial.webm");
ffmpeg("-loop", "1", "-framerate", String(fps), "-i", fiducial, "-t", "6", "-c:v", "libvpx", "-deadline", "realtime", "-crf", "10", "-b:v", "1M", track);
const bytes = readFileSync(track);
Object.assign(source, { path: "fiducial.webm", sha256: hash(bytes), byte_size: bytes.length });

// A different authenticated screen source for the same person must not get the old publication's marks.
const replacementTrackId = "replacement-screen";
const previous = timeline.events.find((event) => event.kind === "media_source_changed" && event.source.sourceId === source.source_id).source;
const replacement = {
  ...previous,
  sourceId: await deriveRecordingMediaSourceId({ recordingId: timeline.recordingId, participantId: source.participant_id, participantGeneration: source.participant_generation, kind: source.kind, trackId: replacementTrackId, epoch: source.track_epoch }),
  trackId: replacementTrackId,
};
media.sources.push({ ...source, source_id: replacement.sourceId, track_id: replacement.trackId, start_ms: replacementMs });
timeline.events.push(
  { atMs: replacementMs, kind: "shared_content_changed", sharedContent: { kind: "none" } },
  { atMs: replacementMs, kind: "media_source_changed", source: { ...previous, visible: false } },
  { atMs: replacementMs, kind: "media_source_changed", source: replacement },
  { atMs: replacementMs, kind: "shared_content_changed", sharedContent: { kind: "screen_share", participantId: sharer.id, sourceId: replacement.sourceId } },
);
// Keep the parity comparison free of unrelated reaction/whiteboard paint.
timeline.events = timeline.events.filter((event) => event.kind !== "reaction_added").map((event) => (event.kind === "shared_content_changed" && event.sharedContent.kind === "whiteboard" ? { ...event, sharedContent: { kind: "none" } } : event));
timeline.events
  .sort((left, right) => left.atMs - right.atMs)
  .forEach((event, index) => {
    event.sequence = index + 1;
  });
request.presentation_sha256 = write(request.presentation_path, timeline);
request.decoded_media_sha256 = write(request.decoded_media_path, media);
write(fixture.requestPath, request);

function mark(index, author, revision, time, lifetime = "keep", color = "#ff00ff", point = TARGETS[index]) {
  return {
    draft: { mark_id: `00000000-0000-4000-8000-000000000${401 + index}`, lifetime, color, width: 1800, shape: { kind: "pen", points: [{ x: Math.round(point.x * 65535), y: Math.round(point.y * 65535) }] } },
    author: { participant_id: author.id, display_name: author.displayName, color },
    created_revision: revision,
    committed_at_ms: time,
    expires_at_ms: lifetime === "fade" ? time + 2000 : null,
  };
}

const sidecar = {
  version: 1,
  recordingId: timeline.recordingId,
  episodeId: timeline.episodeId,
  originAuthorityId: timeline.clock.originAuthorityId,
  captureEpoch: timeline.clock.captureEpoch,
  layers: [
    {
      sourceIds: [source.source_id],
      sidecar: {
        version: 1,
        layer: { layer_id: layerId, publication_id: "fixture-screen-publication", sharer_id: sharer.id, frame: { width, height } },
        initial: { atMs: startMs + 200, revision: 11, paused: false, marks: [mark(0, viewer, 1, -100), mark(1, sharer, 2, -50)] },
        changes: [
          { atMs: 4500, revision: 12, change: { kind: "upsert", mark: mark(2, viewer, 12, 4500, "fade") } },
          { atMs: 4500, revision: 13, change: { kind: "upsert", mark: mark(3, viewer, 13, 4500) } },
          { atMs: 4500, revision: 14, change: { kind: "upsert", mark: mark(4, viewer, 14, 4500) } },
          { atMs: 4500, revision: 15, change: { kind: "upsert", mark: mark(5, viewer, 15, 4500, "keep", "#ff00ff", { x: 0.5, y: 0 }) } },
          { atMs: 4800, revision: 16, change: { kind: "control", paused: true } },
          { atMs: 5300, revision: 17, change: { kind: "control", paused: false } },
          { atMs: 6500, revision: 18, change: { kind: "clear", participant_id: viewer.id } },
        ],
        closedAtMs: endMs,
      },
    },
  ],
};
sidecar.layers[0].sidecar.changes.push(sidecar.layers[0].sidecar.changes[1]);
sidecar.layers.push({
  sourceIds: [replacement.sourceId],
  sidecar: {
    version: 1,
    layer: { layer_id: "00000000-0000-4000-8000-000000000302", publication_id: "fixture-replacement-publication", sharer_id: sharer.id, frame: { width, height } },
    initial: { atMs: 8800, revision: 2, paused: false, marks: [mark(1, sharer, 2, 8600)] },
    changes: [],
    closedAtMs: 9000,
  },
});

function compose(name, annotation, requestPath = fixture.requestPath) {
  const result = join(output, `${name}.json`);
  const video = join(output, `${name}.mp4`);
  const args = [join(renderer, "dist/node/compose.js"), "--request", requestPath, "--result", result, "--output", video, "--threads", "1"];
  if (annotation) args.push("--annotation-sidecar", annotation.path, "--annotation-sha256", annotation.sha);
  return { args, video };
}

function render(name, annotation, requestPath) {
  const { args, video } = compose(name, annotation, requestPath);
  run(process.execPath, args);
  return video;
}

const clean = render("clean");
const emptyPath = join(output, "empty-sidecar.json");
const empty = render("empty", { path: emptyPath, sha: write(emptyPath, { ...sidecar, layers: [] }) });
assert.equal(hash(readFileSync(empty)), hash(readFileSync(clean)), "an empty sidecar must not change a legacy export");
// The production compositor finds the checksum-bound sidecar in the frozen presentation.
function freezeAnnotation(name, annotation, input = request) {
  const path = join(output, `${name}-sidecar.json`);
  const sha = write(path, annotation);
  const asset = { id: "screen_annotation", kind: "screen_annotation", objectKey: "fixture/screen-annotation.json", contentType: "application/json", byteSize: readFileSync(path).byteLength, sha256: sha };
  copyFileSync(path, join(request.asset_directory, sha));
  const presentation = join(output, `${name}-presentation.json`);
  const presentationSHA = write(presentation, { ...timeline, assets: [...timeline.assets, asset] });
  const pathWithAnnotation = join(output, `${name}-request.json`);
  write(pathWithAnnotation, { ...input, presentation_path: presentation, presentation_sha256: presentationSHA });
  return pathWithAnnotation;
}

const rendered = render("annotated", undefined, freezeAnnotation("annotated", sidecar));

const invalidPath = join(output, "invalid-sidecar.json");
const invalidSHA = write(invalidPath, { ...sidecar, recordingId: "wrong-recording" });
const invalid = compose("invalid", { path: invalidPath, sha: invalidSHA });
const rejection = spawnSync(process.execPath, invalid.args, { encoding: "utf8" });
assert.notEqual(rejection.status, 0, "a bad sidecar must fail export");
assert.match(rejection.stderr, /sidecar has a mismatched recordingId/);

const reference = decodeRgb(clean, 138);
const targets = findTargets(reference);
const frameWidth = (targets[4].x - targets[0].x) / (TARGETS[4].x - TARGETS[0].x);
const frameHeight = (targets[4].y - targets[0].y) / (TARGETS[4].y - TARGETS[0].y);
const configs = [
  { frame: 125, shown: [] }, // Before the late checkpoint.
  { frame: 126, shown: [0, 1] }, // Exact checkpoint frame.
  { frame: 134, shown: [0, 1] }, // Just before the first change.
  { frame: 135, shown: [0, 1, 2, 3, 4] },
  { frame: 144, shown: [1] }, // Pause hides viewer marks, not the sharer's marks.
  { frame: 159, shown: [0, 1, 2, 3, 4] },
  { frame: 195, shown: [1] }, // Participant clear retains the sharer's mark.
  { frame: 254, shown: [1] },
  { frame: 264, shown: [1] },
  { frame: 269, shown: [1] },
  { frame: 270, shown: [] }, // Recording-side closure stops ink while media still plays.
  { frame: 255, shown: [] }, // New publication from the same sharer.
];
const errors = [];
for (const { frame, shown } of configs) {
  const image = decodeRgb(rendered, frame);
  for (const [index, point] of targets.entries()) {
    const found = centroid(image, regionAround(point, 14, image), inkPixel);
    if (shown.includes(index)) {
      assert.ok(found, `mark ${index} not painted at frame ${frame}`);
      errors.push(Math.hypot(found.x - point.x, found.y - point.y) / frameWidth);
    } else {
      assert.equal(found, null, `mark ${index} unexpectedly painted at frame ${frame}`);
    }
  }
}
const firstFade = fadePixel(decodeRgb(rendered, 180), targets[2]); // 6000 ms.
const lastFade = fadePixel(decodeRgb(rendered, 191), targets[2]); // 6366 ms.
assert.ok(firstFade > lastFade + 35, `fade should dim over recording frames: ${firstFade} vs ${lastFade}`);
const edge = { x: targets[0].x + frameWidth * (0.5 - TARGETS[0].x), y: targets[0].y - frameHeight * TARGETS[0].y };
const sample = decodeRgb(rendered, 138);
const below = centroid(sample, regionAround({ x: edge.x, y: edge.y + 4 }, 2, sample), inkPixel);
const above = centroid(sample, regionAround({ x: edge.x, y: edge.y - 4 }, 2, sample), inkPixel);
assert.ok(below, "the mark reaching the decoded screen edge must paint inside it");
assert.equal(above, null, "ink must be clipped out of the letterbox");
const bakedTrack = join(output, "media", "baked-ink.webm");
const bakedPoint = { x: 0.26, y: 0.52 };
const bakedX = Math.round(bakedPoint.x * width);
const bakedY = Math.round(bakedPoint.y * height);
ffmpeg("-i", track, "-vf", `drawbox=x=${bakedX - 12}:y=${bakedY - 4}:w=24:h=8:color=magenta:t=fill`, "-c:v", "libvpx", "-deadline", "realtime", "-crf", "10", "-b:v", "1M", bakedTrack);
const bakedBytes = readFileSync(bakedTrack);
const bakedMedia = join(dirname(request.decoded_media_path), "baked-media.json");
const bakedMediaSHA = write(bakedMedia, {
  ...media,
  sources: media.sources.map((item) => (item.source_id === source.source_id ? { ...item, path: "baked-ink.webm", sha256: hash(bakedBytes), byte_size: bakedBytes.length } : item)),
});
const bakedInput = { ...request, decoded_media_path: bakedMedia, decoded_media_sha256: bakedMediaSHA };
const bakedCleanRequest = join(output, "baked-clean-request.json");
write(bakedCleanRequest, bakedInput);
const mixedSidecar = structuredClone(sidecar);
mixedSidecar.layers[0].sidecar.layer.burned_in = true;
const mixed = render("mixed", undefined, freezeAnnotation("mixed", mixedSidecar, bakedInput));
const bakedClean = render("baked-clean", undefined, bakedCleanRequest);
const bakedSourceFrame = decodeRgb(bakedClean, 138);
const bakedTilePoint = {
  x: targets[0].x + frameWidth * (bakedPoint.x - TARGETS[0].x),
  y: targets[0].y + frameHeight * (bakedPoint.y - TARGETS[0].y),
};
assert.ok(centroid(bakedSourceFrame, regionAround(bakedTilePoint, 12, bakedSourceFrame), inkPixel), "the encoded screen source must already contain ink");
assert.ok(decodeRgb(mixed, 138).bytes.equals(bakedSourceFrame.bytes), "burned-in playback must match the unannotated render of the same encoded source");
const mixedReplacement = decodeRgb(mixed, 264);
assert.ok(centroid(mixedReplacement, regionAround(targets[1], 14, mixedReplacement), inkPixel), "the replacement's data-layer mark must still render");

const p95 = percentile(errors, 0.95);
assert.ok(p95 < 0.005, `recorded alignment p95 ${p95} exceeds 0.5%`);

const frame = join(output, "sample-frame.png");
ffmpeg("-i", rendered, "-vf", "select=eq(n\\,138)", "-frames:v", "1", "-update", "1", frame);
const before = join(output, "clean-frame.png");
ffmpeg("-i", clean, "-vf", "select=eq(n\\,138)", "-frames:v", "1", "-update", "1", before);
const report = { verdict: "pass", frame, before, video: rendered, mixedVideo: mixed, measuredMarks: errors.length, p95AlignmentFrameWidth: p95, fade: { firstFade, lastFade }, testedFrames: configs };
write(join(output, "proof.json"), report);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

function findTargets(image) {
  const regions = [
    { x: 18, y: 58, width: 160, height: 175 },
    { x: 120, y: 300, width: 178, height: 165 },
    { x: 230, y: 140, width: 185, height: 185 },
    { x: 420, y: 66, width: 178, height: 195 },
    { x: 535, y: 294, width: 173, height: 146 },
  ];
  return regions.map((region, index) => {
    const point = centroid(image, region, targetPixel);
    assert.ok(point, `missing fiducial ${index}`);
    return point;
  });
}

function fadePixel(image, point) {
  const reference = regionAround({ x: point.x + 5, y: point.y + 4 }, 1, image);
  const offset = (reference.y * image.width + reference.x) * 3;
  return image.bytes[offset + 2];
}
