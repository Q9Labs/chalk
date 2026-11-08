import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callSeconds, captureReady, checkTranscript, transcriptEvidence } from "./call-artifacts.mjs";
import { parseVolume, recordingEvidence, recordingFailures } from "./recording-evidence.mjs";
import { decodeFrames, tileEvidence } from "./tile-frames.mjs";

const hasFfmpeg = ["ffmpeg", "ffprobe"].every((program) => spawnSync(program, ["-version"]).status === 0);

test("the call must last long enough for every guest to speak", () => {
  assert.equal(callSeconds({}), 60);
  assert.equal(callSeconds({ CHALK_PROOF_CALL_SECONDS: "45" }), 45);
  assert.throws(() => callSeconds({ CHALK_PROOF_CALL_SECONDS: "20" }), /at least 40/);
  assert.throws(() => callSeconds({ CHALK_PROOF_CALL_SECONDS: "abc" }), /at least 40/);
});

const header = "chalk-proof:run · 8 Nov 2026 · 1 min\nLanguages: English\n\n";
test("an empty Transcript fails even though the text has a title block", () => {
  for (const text of [`${header}No speech was transcribed.\n`, header, ""]) {
    const evidence = transcriptEvidence(text);
    assert.equal(evidence.wordCount, 0);
    assert.throws(() => checkTranscript(evidence), /Transcript is empty/);
  }
});
test("the Transcript must carry every guest's own phrase and reports the speaker lines", () => {
  const lines = ["[00:00:03] Proof guest 1: The purple lantern shines beside the quiet river.", "[00:00:15] Proof guest 2: Seven copper kettles are boiling on the mountain.", "[00:00:27] Proof guest 3: A green falcon crosses the silver harbor at dawn."];
  const evidence = transcriptEvidence(`${header}${lines.join("\n")}\n`);
  assert.deepEqual(evidence.speakers, ["Proof guest 1", "Proof guest 2", "Proof guest 3"]);
  assert.equal(evidence.wordCount, 25);
  assert.ok(evidence.excerpt.startsWith("[00:00:03] Proof guest 1"));
  checkTranscript(evidence);
  const missing = transcriptEvidence(`${header}${lines.slice(0, 2).join("\n")}\n`);
  assert.throws(() => checkTranscript(missing), /missing from Transcript for guest 3/);
});

test("the volume summary uses the last ffmpeg report, which covers the whole stream", () => {
  const stderr = "[Parsed_volumedetect_0 @ 0x1] n_samples: 0\n[Parsed_volumedetect_0 @ 0x2] n_samples: 288000\n[Parsed_volumedetect_0 @ 0x2] mean_volume: -21.1 dB\n[Parsed_volumedetect_0 @ 0x2] max_volume: -16.1 dB\n";
  assert.deepEqual(parseVolume(stderr), { samples: 288000, meanDb: -21.1, maxDb: -16.1 });
});

const camera = { visible: true, moving: true };
const sound = { codec: "aac", samples: 288000, meanDb: -21, maxDb: -16 };
const good = { durationSeconds: 60, video: { decodedFrames: 900 }, audio: sound, frameMeans: [60, 61, 62], guests: [1, 2, 3].map((guest) => ({ guest, camera })) };
test("a Recording without audio, video, frames or sound fails", () => {
  assert.deepEqual(recordingFailures(good, 48), []);
  assert.deepEqual(recordingFailures({ ...good, audio: null }, 48), ["Recording has no audio stream"]);
  assert.deepEqual(recordingFailures({ ...good, audio: { ...sound, maxDb: -91 } }, 48), ["Recording audio is silent"]);
  assert.deepEqual(recordingFailures({ ...good, audio: { ...sound, samples: 0 } }, 48), ["Recording audio is silent"]);
  assert.deepEqual(recordingFailures({ ...good, video: { decodedFrames: 0 } }, 48), ["Recording video decoded zero frames"]);
  assert.deepEqual(recordingFailures({ ...good, video: null, frameMeans: [], guests: good.guests.map(({ guest }) => ({ guest, camera: null })) }, 48), ["Recording has no video stream"]);
  assert.match(recordingFailures({ ...good, durationSeconds: 20 }, 48)[0], /shorter than the 48s call/);
  assert.match(recordingFailures({ ...good, frameMeans: [60, 1, 62] }, 48)[0], /black frame/);
  assert.deepEqual(recordingFailures({ ...good, guests: [good.guests[0], { guest: 2, camera: { visible: false, moving: false } }, { guest: 3, camera: { visible: true, moving: false } }] }, 48), ["Recording does not show guest 2's camera", "Recording shows guest 3's camera frozen"]);
});

// Real media through ffprobe, ffmpeg and the recorder's analyzer. Tiles use the three guest camera colours.
const tiles = ["0x1b365d", "0x613c69", "0x5d2a1b"];
// `frozen` tiles keep their square still; `blackAfter` maps a tile index to the second its picture goes black;
// `labels` lists tiles with a grey label band across their full width, below the moving square;
// `squares` maps a tile index to the colour of its moving square (white by default).
function video(tileColors, { frozen = [], blackAfter = {}, squares = {}, labels = [] } = {}) {
  const boxes = tileColors
    .map((color, index) => `drawbox=x=${index * 107}:y=0:w=106:h=180:color=${color}:t=fill:enable='lt(t,${blackAfter[index] ?? 1000})'`)
    .concat(labels.map((index) => `drawbox=x=${index * 107}:y=60:w=106:h=20:color=0x808080:t=fill`))
    .join(",");
  const moving = (index) => (frozen.includes(index) ? "0" : "mod(n*9,80)");
  const overlays = tileColors.map((_, index) => `[${index === 0 ? "bg" : `t${index}`}][${index + 1}:v]overlay=x='${index * 107}+${moving(index)}':y=40:eval=frame[t${index + 1}]`).join(";");
  return { inputs: tileColors.flatMap((_, index) => ["-f", "lavfi", "-i", `color=c=${squares[index] ?? "white"}:s=16x16:r=15:d=6`]), graph: `[0:v]${boxes}[bg];${overlays}`, output: `[t${tileColors.length}]` };
}
async function fixture(directory, name, { tileColors = tiles, audio = "sine=frequency=440:sample_rate=48000:d=6", ...pictureOptions } = {}) {
  const picture = video(tileColors, pictureOptions);
  const file = join(directory, `${name}.mp4`);
  const audioInput = audio ? ["-f", "lavfi", "-i", audio] : [];
  const map = audio ? ["-map", `${tileColors.length + 1}:a`, "-c:a", "aac"] : [];
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=320x180:r=15:d=6", ...picture.inputs, ...audioInput, "-filter_complex", picture.graph, "-map", picture.output, ...map, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-shortest", file]);
  return file;
}
test("recorded media is judged by its decoded frames, sound and each guest's tile", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "call-artifacts-"));
  try {
    const evidence = await recordingEvidence(await fixture(directory, "good"), 3);
    assert.equal(evidence.video.decodedFrames, 90);
    assert.ok(evidence.audio.samples > 0 && evidence.audio.maxDb > -50);
    assert.ok(Math.abs(evidence.durationSeconds - 6) < 0.3);
    assert.deepEqual(recordingFailures(evidence, 4), []);

    const silent = await recordingEvidence(await fixture(directory, "silent", { audio: "anullsrc=r=48000:cl=mono:d=6" }), 3);
    assert.deepEqual(recordingFailures(silent, 4), ["Recording audio is silent"]);

    const mute = await recordingEvidence(await fixture(directory, "mute", { audio: null }), 3);
    assert.deepEqual(recordingFailures(mute, 4), ["Recording has no audio stream"]);

    const twoTiles = await recordingEvidence(await fixture(directory, "two", { tileColors: tiles.slice(0, 2) }), 3);
    assert.deepEqual(recordingFailures(twoTiles, 4), ["Recording does not show guest 3's camera"]);
    assert.equal(twoTiles.guests[2].tile.liveFrames, 0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("each guest's tile is counted by its live decoded frames over the whole Recording", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "call-artifacts-tiles-"));
  try {
    const good = await recordingEvidence(await fixture(directory, "good"), 3);
    for (const { tile } of good.guests) {
      assert.ok(tile.intervals >= 10, `sampled ${tile.intervals} intervals`);
      assert.equal(tile.liveFrames, tile.intervals);
      assert.equal(tile.liveShare, 1);
    }
    assert.deepEqual(recordingFailures(good, 4), []);

    // Guest 2's picture turns black after 2 of the 6 seconds: the three early samples still pass.
    const blackened = await recordingEvidence(await fixture(directory, "blackened", { blackAfter: { 1: 2 } }), 3);
    assert.ok(blackened.guests[1].tile.liveShare < 0.6);
    assert.ok(blackened.guests[0].tile.liveShare === 1 && blackened.guests[2].tile.liveShare === 1);
    assert.match(recordingFailures(blackened, 4).join(";"), /guest 2's/);

    // A tile that keeps its colour but never changes is not live video.
    const frozen = await recordingEvidence(await fixture(directory, "frozen", { frozen: [0] }), 3);
    assert.equal(frozen.guests[0].tile.liveFrames, 0);
    assert.equal(frozen.guests[0].tile.visibleFrames, frozen.guests[0].tile.intervals + 1);
    assert.match(recordingFailures(frozen, 4).join(";"), /guest 1's camera frozen/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("another guest's animation never makes a fully frozen tile pass", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "call-artifacts-frozen-"));
  try {
    // Guests 1 and 3 animate squares in guest 2's own camera colour; guest 2's whole picture is frozen.
    const evidence = await recordingEvidence(await fixture(directory, "other-squares", { frozen: [1], squares: { 0: tiles[1], 2: tiles[1] } }), 3);
    assert.equal(evidence.guests[1].tile.liveFrames, 0);
    assert.equal(evidence.guests[0].tile.liveShare, 1);
    assert.equal(evidence.guests[2].tile.liveShare, 1);
    assert.match(recordingFailures(evidence, 4).join(";"), /no live video in guest 2's tile/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a live tile split by a full-width label still counts as live", { skip: !hasFfmpeg && "ffmpeg is not installed" }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "call-artifacts-label-"));
  try {
    // The label leaves the larger patch of guest 2's colour below it, which has no motion; the moving square is in the smaller one above.
    const evidence = await recordingEvidence(await fixture(directory, "label", { labels: [1] }), 3);
    assert.equal(evidence.guests[1].tile.liveShare, 1);
    assert.deepEqual(recordingFailures(evidence, 4), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a Recording the decoder rejects fails with the tool name and exit code", async () => {
  await assert.rejects(tileEvidence(decodeFrames("/nonexistent/missing.mp4"), 3), /ffmpeg failed \(exit \d+\)/);
});

test("a tile with zero or a minority of live frames fails with the guest, the others pass", () => {
  const base = { bytes: 1, durationSeconds: 60, video: { decodedFrames: 900 }, audio: { samples: 1, maxDb: -10 }, frameMeans: [60, 60, 60] };
  const camera = { visible: true, moving: true };
  const tile = (guest, intervals, liveFrames) => ({ guest, intervals, liveFrames, visibleFrames: intervals, liveShare: liveFrames / intervals });
  const guests = (...counts) => counts.map((live, index) => ({ guest: index + 1, camera, tile: tile(index + 1, 100, live) }));
  assert.deepEqual(recordingFailures({ ...base, guests: guests(100, 61, 99) }, 48), []);
  assert.deepEqual(recordingFailures({ ...base, guests: guests(100, 59, 99) }, 48), ["Recording shows guest 2's tile live for 59% of the call, below the 60% minimum"]);
  assert.deepEqual(recordingFailures({ ...base, guests: guests(100, 100, 0) }, 48), ["Recording shows no live video in guest 3's tile (0 of 100 sampled intervals)"]);
});

test("a failed Capture names its failure code, and only a recording Capture is ready", () => {
  assert.throws(() => captureReady({ recordingId: "r1", status: "failed", failureCode: "recording_capture_unsupported" }), /Capture failed before readiness: recording_capture_unsupported/);
  assert.throws(() => captureReady({ recordingId: "r1", status: "failed", failureCode: null }), /Capture failed before readiness: no failure code/);
  assert.equal(captureReady(null), false);
  assert.equal(captureReady({ recordingId: "r1", status: "starting", failureCode: null }), false);
  assert.equal(captureReady({ recordingId: "r1", status: "recording", failureCode: null }), true);
});
