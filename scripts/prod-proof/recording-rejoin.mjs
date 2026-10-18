import { contactSheetFont } from "./contact-sheet.mjs";
import { command, check, save } from "./runtime.mjs";

const colors = {
  before: [
    [27, 54, 93],
    [97, 60, 105],
  ],
  after: [
    [24, 93, 69],
    [105, 70, 29],
  ],
};
const width = 320;
const height = 180;

export async function recordingRejoinWindow(run, { pages, rejoin, participants }) {
  const timeline = { participants, beforeStartedAt: Date.now() };
  await run.wait(25_000);
  timeline.closedAt = Date.now();
  const participant = await rejoin(1);
  check(participant === participants[1], "Rejoin changed guest B's participant identity");
  timeline.rejoinedAt = Date.now();
  for (const page of pages)
    await page.evaluate(() => {
      window.proofPhase = "after";
    });
  await run.wait(25_000);
  timeline.endRequestedAt = Date.now();
  run.rejoin = timeline;
  await save(`${run.directory}/rejoin-timeline.json`, timeline);
}

function near(pixel, color) {
  return color.every((channel, index) => Math.abs(channel - pixel[index]) <= 22);
}

// Check the exported pixels, not live browser counters. Phase-specific backgrounds
// also reject a mistaken export-clock alignment or a frozen pre-rejoin picture.
function cameraRegion(frame, color) {
  const region = { count: 0, left: width, right: -1, top: height, bottom: -1 };
  for (let pixel = 0; pixel < width * height; pixel++) {
    if (!near(frame.subarray(pixel * 3, pixel * 3 + 3), color)) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    region.count++;
    region.left = Math.min(region.left, x);
    region.right = Math.max(region.right, x);
    region.top = Math.min(region.top, y);
    region.bottom = Math.max(region.bottom, y);
  }
  return region;
}
function* regionPixels(region) {
  for (let y = region.top; y <= region.bottom; y++) {
    for (let x = region.left; x <= region.right; x++) yield (y * width + x) * 3;
  }
}
function changedFraction(before, after, region) {
  let changed = 0;
  let pixels = 0;
  for (const offset of regionPixels(region)) {
    if ([0, 1, 2].some((channel) => Math.abs(after[offset + channel] - before[offset + channel]) > 35)) changed++;
    pixels++;
  }
  return changed / pixels;
}
export function cameraEvidence(frames, phase, guest) {
  const regions = frames.map((frame) => cameraRegion(frame, colors[phase][guest]));
  const visible = frames.length === 3 && regions.every(({ count }) => count >= width * height * 0.03);
  const changes = visible ? frames.slice(1).map((frame, index) => changedFraction(frames[index], frame, regions[index + 1])) : [];
  return { visible, moving: visible && changes.every((fraction) => fraction > 0.003), regions, changedFractions: changes };
}

// The MP4 mixes audio, so attribute its energy using the two injected frequencies.
// Projection rejects the other guest's tone; ordinary mixed RMS alone cannot do so.
export function toneEvidence(pcm, frequency) {
  const samples = pcm.length / 4;
  let sine = 0,
    cosine = 0,
    energy = 0;
  for (let index = 0; index < samples; index++) {
    const value = pcm.readFloatLE(index * 4);
    const angle = (2 * Math.PI * frequency * index) / 48_000;
    sine += value * Math.sin(angle);
    cosine += value * Math.cos(angle);
    energy += value * value;
  }
  const rms = Math.sqrt(2 * (sine * sine + cosine * cosine)) / samples;
  const db = (value) => 20 * Math.log10(Math.max(value, 1e-12));
  const toneDbFS = db(rms);
  return { frequencyHz: frequency, toneDbFS, mixedDbFS: db(Math.sqrt(energy / samples)), present: samples >= 48_000 && toneDbFS > -45 };
}

async function sampleWindow(run, phase, times) {
  const frames = [];
  const images = [];
  const audio = [];
  const mp4 = `${run.directory}/export.mp4`;
  for (const [index, time] of times.entries()) {
    const args = ["-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", mp4, "-frames:v", "1"];
    const frame = `${run.directory}/rejoin-${phase}-${index + 1}.png`;
    await command("ffmpeg", [...args, "-y", "-vf", "scale=1000:-1", frame], { signal: run.signal });
    images.push({ frame, label: `${phase === "before" ? "Before" : "After"} rejoin / sample ${index + 1}` });
    const rgb = await command("ffmpeg", [...args, "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer", signal: run.signal });
    check(rgb.length === width * height * 3, "Export frame decode returned incomplete pixels");
    frames.push(rgb);
    audio.push(await command("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", mp4, "-t", "3", "-vn", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1"], { encoding: "buffer", signal: run.signal }));
  }
  return { frames, images, audio };
}
function windowEvidence(sample, phase, times) {
  const guests = [0, 1].map((guest) => ({
    guest: guest + 1,
    camera: cameraEvidence(sample.frames, phase, guest),
    audio: sample.audio.map((pcm) => toneEvidence(pcm, [440, 880][guest])),
  }));
  const failures = guests.flatMap(({ guest, camera, audio }) => [...(!camera.visible || !camera.moving ? [`${phase}: guest ${guest} camera missing or frozen`] : []), ...(!audio.every((value) => value.present) ? [`${phase}: guest ${guest} tone missing`] : [])]);
  return { sampleSeconds: times, audioWindowSeconds: 3, guests, failures };
}
async function contactSheet(run, samples) {
  const sheet = samples.before.images.flatMap((image, index) => [image, samples.after.images[index]]);
  const font = contactSheetFont(await command("magick", ["-list", "font"], { signal: run.signal }));
  const path = `${run.directory}/rejoin-contact-sheet.png`;
  await command("magick", ["montage", "-font", font, "-pointsize", "24", ...sheet.flatMap(({ frame, label }) => ["-label", label, frame]), "-tile", "2x3", "-geometry", "+16+16", path], { signal: run.signal });
  return path;
}
export async function recordingRejoinProof(run, exported) {
  const timeline = run.rejoin;
  // Export time zero is the recorder clock, not the recording-start HTTP request.
  // Anchor to its end; phase colors reject a wrong mapping.
  const at = (wall) => exported.durationSeconds - (timeline.endRequestedAt - wall) / 1000;
  const windows = {
    before: [at(timeline.closedAt - 15_000), at(timeline.closedAt - 10_000), at(timeline.closedAt - 5000)],
    after: [at(timeline.endRequestedAt - 15_000), at(timeline.endRequestedAt - 10_000), at(timeline.endRequestedAt - 5000)],
  };
  const result = { identityPreserved: true, attribution: "camera phase colors and motion; 440/880 Hz guest-specific energy in mixed MP4", windows: {}, failures: [] };
  const samples = {};
  for (const [phase, times] of Object.entries(windows)) {
    check(times[0] >= 0 && times[2] + 3 < exported.durationSeconds, "Rejoin sample window lies outside the export");
    samples[phase] = await sampleWindow(run, phase, times);
    result.windows[phase] = windowEvidence(samples[phase], phase, times);
    result.failures.push(...result.windows[phase].failures);
  }
  result.contactSheet = await contactSheet(run, samples);
  result.result = result.failures.length ? "failed" : "passed";
  await save(`${run.directory}/recording-rejoin-proof.json`, result);
  check(!result.failures.length, result.failures.join("; "));
  return result;
}
