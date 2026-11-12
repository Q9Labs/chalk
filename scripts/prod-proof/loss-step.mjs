// What a viewer's video and audio did through one stretch of downlink loss, from the samples a guest page took of its own call
// (recovery-sampler.mjs). Pure functions, pinned by loss-step.test.mjs.
import { flowGap } from "./recovery-analysis.mjs";

/** Seconds of steady decoding at the pre-loss frame width that count as back on the high layer. */
const STEADY_S = 3;
/** Seconds before the loss that give the pre-loss bitrate and frame width. */
const BEFORE_S = 10;

/**
 * @typedef {{ t: number, fa: boolean, fv: boolean, vb: number, vf: number, vw: number }} LossSample
 *   vb and vf: running totals of received video bytes and decoded frames; vw: width in pixels of the frame being decoded.
 */

/** The last sample at or before `time`, or the first one when none is. */
function at(samples, time) {
  let found = samples[0];
  for (const sample of samples) {
    if (sample.t > time) break;
    found = sample;
  }
  return found;
}

/**
 * lossStepOf reports one viewer's video through a loss step that starts at `faultStart` and ends at `faultEnd`, watched until
 * `watchEnd` (host clock, ms). Per whole second it takes the video kbit/s and decoded frames, then:
 *  - before_kbps: mean video bitrate in the BEFORE_S seconds before the loss;
 *  - lowest_kbps: the lowest second between the start and the end of the loss;
 *  - zero_fps_s and longest_zero_fps_s: seconds with no decoded frame from the start of the loss to the end of the watch, in total and
 *    in one stretch;
 *  - back_to_high_s: seconds from the end of the loss until the frame width returned to its pre-loss value and stayed there for
 *    STEADY_S seconds, 0 when it never left, null when it did not return;
 *  - audio_longest_gap_ms: the longest stretch without an audio packet, at the sampler's 100 ms resolution.
 * @param {LossSample[]} samples
 * @param {{ faultStart: number, faultEnd: number, watchEnd: number }} window
 */
export function lossStepOf(samples, { faultStart, faultEnd, watchEnd }) {
  const first = faultStart - BEFORE_S * 1000;
  const seconds = [];
  for (let start = first; start + 1000 <= watchEnd; start += 1000) {
    const from = at(samples, start);
    const to = at(samples, start + 1000);
    seconds.push({ start, kbps: Math.round(((to.vb - from.vb) * 8) / 1000), frames: to.vf - from.vf, width: to.vw });
  }
  const before = seconds.filter((second) => second.start < faultStart);
  const during = seconds.filter((second) => second.start >= faultStart && second.start < faultEnd);
  const after = seconds.filter((second) => second.start >= faultStart);
  const beforeKbps = Math.round(before.reduce((sum, second) => sum + second.kbps, 0) / Math.max(1, before.length));
  const widthBefore = Math.max(0, ...before.map((second) => second.width));

  let longestZero = 0;
  let run = 0;
  for (const second of after) {
    run = second.frames === 0 ? run + 1 : 0;
    longestZero = Math.max(longestZero, run);
  }

  const settled = seconds.filter((second) => second.start >= faultEnd);
  let backToHigh = null;
  for (let index = 0; index + STEADY_S <= settled.length; index++) {
    const stretch = settled.slice(index, index + STEADY_S);
    if (stretch.every((second) => second.width >= widthBefore && second.frames > 0)) {
      backToHigh = Math.round(Math.max(0, stretch[0].start - faultEnd) / 100) / 10;
      break;
    }
  }

  return {
    before_kbps: beforeKbps,
    lowest_kbps: Math.min(...during.map((second) => second.kbps)),
    zero_fps_s: after.filter((second) => second.frames === 0).length,
    longest_zero_fps_s: longestZero,
    back_to_high_s: backToHigh,
    audio_longest_gap_ms: flowGap(samples, "fa", faultStart - 1000, watchEnd).gap_ms,
  };
}
