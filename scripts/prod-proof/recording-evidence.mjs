import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cameraEvidence, frameSize } from "./recording-rejoin.mjs";
import { check } from "./runtime.mjs";
import { decodeFrames, tileEvidence, tileFailure } from "./tile-frames.mjs";

const execute = promisify(execFile);
const analyzer = new URL("../recorder/analyze-media.mjs", import.meta.url).pathname;
const maxBuffer = 64 * 1024 * 1024;

// ffprobe, ffmpeg and the analyzer print file names and codec details but never credentials.
async function tool(program, args, options = {}) {
  try {
    return await execute(program, args, { maxBuffer, timeout: 300_000, ...options });
  } catch (error) {
    // The analyzer exits 1 with a complete JSON report when one of its assertions fails.
    if (options.acceptExit1 && error.code === 1 && error.stdout) return error;
    throw new Error(`${program} failed (exit ${error.code ?? "unknown"})`);
  }
}

export function parseVolume(stderr) {
  // ffmpeg may print the filter's summary twice; the last one covers the whole stream.
  const number = (name) => Number([...stderr.matchAll(new RegExp(`${name}: (-?[\\d.]+)`, "g"))].at(-1)?.[1]);
  return { samples: number("n_samples") || 0, meanDb: number("mean_volume"), maxDb: number("max_volume") };
}

// A decoded frame is black when its average channel value is near zero.
function meanChannel(rgb) {
  let sum = 0;
  for (const value of rgb) sum += value;
  return sum / rgb.length;
}

async function sampleFrames(file, times) {
  const { width, height } = frameSize;
  return Promise.all(
    times.map(async (time) => {
      const { stdout } = await tool("ffmpeg", ["-hide_banner", "-loglevel", "error", "-ss", String(time), "-i", file, "-frames:v", "1", "-vf", `scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"], { encoding: "buffer" });
      return stdout;
    }),
  );
}

// The Recording is one composite MP4, so per-guest presence comes from each guest's camera
// colour in three frames and in a frame sampled every half second for the live-tile counts; the mixed audio is checked for sound, and the Transcript attributes speech.
export async function recordingEvidence(file, guestCount) {
  const analysis = JSON.parse((await tool("node", [analyzer, "--input", file, "--scan-anomalies"], { acceptExit1: true })).stdout);
  const probe = JSON.parse((await tool("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames", "-of", "json", file])).stdout);
  const hasAudio = analysis.audio !== null;
  const volume = hasAudio ? parseVolume((await tool("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-vn", "-af", "volumedetect", "-f", "null", "-"])).stderr) : { samples: 0, meanDb: -Infinity, maxDb: -Infinity };
  const durationSeconds = (analysis.format.duration_ms ?? 0) / 1000;
  const frames =
    analysis.video === null || durationSeconds <= 0
      ? []
      : await sampleFrames(
          file,
          [0.25, 0.5, 0.75].map((fraction) => durationSeconds * fraction),
        );
  const tiles = frames.length === 0 ? [] : await tileEvidence(decodeFrames(file), guestCount);
  return {
    bytes: analysis.input.bytes,
    durationSeconds,
    video: analysis.video && { codec: analysis.video.codec, width: analysis.video.width, height: analysis.video.height, decodedFrames: Number(probe.streams?.[0]?.nb_read_frames) || 0 },
    audio: hasAudio ? { codec: analysis.audio.codec, ...volume } : null,
    anomalies: analysis.anomalies,
    analyzerFailures: analysis.assertions.filter((assertion) => !assertion.passed).map(({ name, actual, expected }) => ({ name, actual, expected })),
    frameMeans: frames.map(meanChannel),
    guests: Array.from({ length: guestCount }, (_, guest) => ({ guest: guest + 1, camera: frames.length === 3 ? cameraEvidence(frames, "before", guest) : null, tile: tiles[guest] ?? null })),
  };
}

export function recordingFailures(evidence, minimumSeconds) {
  const failures = [];
  if (!evidence.video) failures.push("Recording has no video stream");
  else if (evidence.video.decodedFrames === 0) failures.push("Recording video decoded zero frames");
  if (!evidence.audio) failures.push("Recording has no audio stream");
  else if (evidence.audio.samples === 0 || !(evidence.audio.maxDb > -50)) failures.push("Recording audio is silent");
  if (evidence.durationSeconds < minimumSeconds) failures.push(`Recording is ${evidence.durationSeconds.toFixed(1)}s, shorter than the ${minimumSeconds}s call`);
  if (evidence.video && evidence.frameMeans.some((mean) => mean < 4)) failures.push("Recording has a black frame");
  for (const { guest, camera, tile } of evidence.guests) {
    const tileProblem = tile && tileFailure(tile);
    if (evidence.video && !camera?.visible) failures.push(`Recording does not show guest ${guest}'s camera`);
    else if (camera && !camera.moving) failures.push(`Recording shows guest ${guest}'s camera frozen`);
    else if (evidence.video && tileProblem) failures.push(tileProblem);
  }
  return failures;
}

export function checkRecording(evidence, minimumSeconds) {
  const failures = recordingFailures(evidence, minimumSeconds);
  check(!failures.length, failures.join("; "));
}
