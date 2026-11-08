import { spawn } from "node:child_process";
import { changedFraction, cameraRegion, colors, frameSize } from "./recording-rejoin.mjs";

const { width, height } = frameSize;
const frameBytes = width * height * 3;

/** Frames per second of the Recording that are sampled for each guest's tile. */
export const tileSampleRate = 2;
/** A guest's tile must be live in at least this share of the sampled Recording. */
export const minimumLiveShare = 0.6;
// Same thresholds as `cameraEvidence`: the camera colour fills 3% of the frame, and 0.3% of the tile moves between samples.
const visibleShare = 0.03;
const movingShare = 0.003;

/** Decodes the Recording at `tileSampleRate` frames per second into raw RGB frames, without buffering the whole video. */
export async function* decodeFrames(file) {
  const args = ["-hide_banner", "-loglevel", "error", "-i", file, "-an", "-vf", `fps=${tileSampleRate},scale=${width}:${height}`, "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"];
  const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"], timeout: 300_000 });
  // Resolve, never reject: a spawn error can arrive before the stream loop below finishes.
  const finished = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code) => resolve({ code }));
  });
  let buffered = Buffer.alloc(0);
  for await (const chunk of child.stdout) {
    buffered = Buffer.concat([buffered, chunk]);
    while (buffered.length >= frameBytes) {
      yield buffered.subarray(0, frameBytes);
      buffered = buffered.subarray(frameBytes);
    }
  }
  const { error, code } = await finished;
  if (error || code !== 0) throw new Error(`ffmpeg failed (exit ${code ?? "unknown"})`);
}

/**
 * Counts, per guest, the sampled frames of the composite in which that guest's tile is live:
 * the guest's camera colour fills the tile and the picture inside it moved since the previous sample.
 * A black tile is never visible; a frozen picture is visible but never moves.
 * `frames` is any (async) iterable of raw RGB frames in time order.
 */
export async function tileEvidence(frames, guestCount) {
  const tiles = Array.from({ length: guestCount }, (_, index) => ({ guest: index + 1, intervals: 0, visibleFrames: 0, liveFrames: 0 }));
  let previous;
  for await (const frame of frames) {
    for (const [index, tile] of tiles.entries()) {
      const region = cameraRegion(frame, colors.before[index]);
      const visible = region.count >= width * height * visibleShare;
      if (previous) tile.intervals++;
      if (visible) tile.visibleFrames++;
      if (visible && previous && changedFraction(previous, frame, region) > movingShare) tile.liveFrames++;
    }
    previous = frame;
  }
  return tiles.map((tile) => ({ ...tile, liveShare: tile.intervals ? tile.liveFrames / tile.intervals : 0, liveSeconds: tile.liveFrames / tileSampleRate }));
}

/** Why a guest's tile does not prove live video, or nothing when it does. */
export function tileFailure({ guest, intervals, liveFrames, liveShare }) {
  if (liveFrames === 0) return `Recording shows no live video in guest ${guest}'s tile (0 of ${intervals} sampled intervals)`;
  if (liveShare < minimumLiveShare) return `Recording shows guest ${guest}'s tile live for ${Math.round(liveShare * 100)}% of the call, below the ${minimumLiveShare * 100}% minimum`;
}
