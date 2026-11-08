import { spawn } from "node:child_process";
import { changedFraction, colors, frameSize } from "./recording-rejoin.mjs";

const { width, height } = frameSize;
const frameBytes = width * height * 3;

/** Frames per second of the Recording that are sampled for each guest's tile. */
export const tileSampleRate = 2;
/** A guest's tile must be live in at least this share of the sampled Recording. */
export const minimumLiveShare = 0.6;
// Same thresholds as `cameraEvidence`: the camera colour fills 3% of the frame, and 0.3% of the tile moves between samples.
const visibleShare = 0.03;
const movingShare = 0.003;
// A label or border can split a tile into patches of its colour: a patch this close to the largest one
// (in pixels of the 320x180 frame), spanning at least half of its width or height and not sticking out past it, belongs to the same tile.
const splitGap = 24;
const splitSlack = 4;
const splitSpan = 0.5;

function colorNear(frame, offset, color) {
  return Math.abs(color[0] - frame[offset]) <= 22 && Math.abs(color[1] - frame[offset + 1]) <= 22 && Math.abs(color[2] - frame[offset + 2]) <= 22;
}

/** The connected patches of `color` in a frame, each with its pixel count and bounding box. */
function colorPatches(frame, color) {
  const open = new Uint8Array(width * height);
  for (let pixel = 0; pixel < open.length; pixel++) open[pixel] = colorNear(frame, pixel * 3, color) ? 1 : 0;
  const stack = new Int32Array(open.length);
  const patches = [];
  for (let seed = 0; seed < open.length; seed++) {
    if (!open[seed]) continue;
    const patch = { count: 0, left: width, right: -1, top: height, bottom: -1 };
    let size = 0;
    stack[size++] = seed;
    open[seed] = 0;
    while (size) {
      const pixel = stack[--size];
      const x = pixel % width;
      const y = (pixel - x) / width;
      patch.count++;
      patch.left = Math.min(patch.left, x);
      patch.right = Math.max(patch.right, x);
      patch.top = Math.min(patch.top, y);
      patch.bottom = Math.max(patch.bottom, y);
      for (const next of [x > 0 ? pixel - 1 : -1, x < width - 1 ? pixel + 1 : -1, y > 0 ? pixel - width : -1, y < height - 1 ? pixel + width : -1]) {
        if (next < 0 || !open[next]) continue;
        open[next] = 0;
        stack[size++] = next;
      }
    }
    patches.push(patch);
  }
  return patches;
}

const gap = (lowA, highA, lowB, highB) => Math.max(0, lowB - highA - 1, lowA - highB - 1);
const length = (low, high) => high - low + 1;

/** Whether `patch` is a piece of the tile that `main` anchors, cut off by a label or border across it. */
function splitsTile(main, patch) {
  const across = (low, high, mainLow, mainHigh) => low >= mainLow - splitSlack && high <= mainHigh + splitSlack && length(low, high) >= splitSpan * length(mainLow, mainHigh);
  const gapX = gap(main.left, main.right, patch.left, patch.right);
  const gapY = gap(main.top, main.bottom, patch.top, patch.bottom);
  const cutAcrossY = gapY > 0 && gapY <= splitGap && gapX === 0 && across(patch.left, patch.right, main.left, main.right);
  const cutAcrossX = gapX > 0 && gapX <= splitGap && gapY === 0 && across(patch.top, patch.bottom, main.top, main.bottom);
  return cutAcrossY || cutAcrossX;
}

/**
 * The guest's own tile: its largest patch of camera colour plus the pieces of it that a label or border cut off.
 * Same-colour pixels elsewhere, such as another guest's animated squares, are not part of it.
 */
export function tileRegion(frame, color) {
  const patches = colorPatches(frame, color);
  if (!patches.length) return { count: 0, left: width, right: -1, top: height, bottom: -1 };
  const main = patches.reduce((largest, patch) => (patch.count > largest.count ? patch : largest));
  const pieces = patches.filter((patch) => patch === main || splitsTile(main, patch));
  return {
    count: pieces.reduce((sum, piece) => sum + piece.count, 0),
    left: Math.min(...pieces.map((piece) => piece.left)),
    right: Math.max(...pieces.map((piece) => piece.right)),
    top: Math.min(...pieces.map((piece) => piece.top)),
    bottom: Math.max(...pieces.map((piece) => piece.bottom)),
  };
}

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
 * the guest's tile (see `tileRegion`) shows its camera colour and the picture inside it moved since the previous sample.
 * A black tile is never visible; a frozen picture is visible but never moves.
 * `frames` is any (async) iterable of raw RGB frames in time order.
 */
export async function tileEvidence(frames, guestCount) {
  const tiles = Array.from({ length: guestCount }, (_, index) => ({ guest: index + 1, intervals: 0, visibleFrames: 0, liveFrames: 0 }));
  let previous;
  for await (const frame of frames) {
    for (const [index, tile] of tiles.entries()) {
      const region = tileRegion(frame, colors.before[index]);
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
