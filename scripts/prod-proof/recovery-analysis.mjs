// Turns the samples a guest page took of its own call into the numbers a recovery run reports. Pure functions: the page-side sampler
// is installRecoverySampler (recovery.mjs), and recovery-analysis.test.mjs pins these against hand-made sample lists.

/** A gap in the flow longer than this is an interruption. Audio arrives every 20 ms and video every 33 ms, so 2 s is not jitter. */
export const INTERRUPTION_MS = 2000;

/**
 * @typedef {{ t: number, fa: boolean, fv: boolean, status: string | null }} RecoverySample
 *   t: time in ms on the host clock; fa and fv: audio packets and decoded video frames arrived since the previous sample;
 *   status: the SDK's connection status.
 */

/**
 * flowGap finds the longest stretch without a new packet (kind "fa") or frame (kind "fv") from `from` to `until`.
 * @param {RecoverySample[]} samples
 * @param {"fa" | "fv"} kind
 * @param {number} from
 * @param {number} until
 * @returns {{ gap_ms: number, stalled_at: number, back_at: number | null }}
 *   back_at is null when the flow never resumed before `until`.
 */
export function flowGap(samples, kind, from, until) {
  const times = samples.filter((sample) => sample[kind] && sample.t >= from && sample.t <= until).map((sample) => sample.t);
  let previous = from;
  let best = { gap_ms: 0, stalled_at: from, back_at: /** @type {number | null} */ (from) };
  for (const t of times) {
    if (t - previous > best.gap_ms) best = { gap_ms: Math.round(t - previous), stalled_at: previous, back_at: t };
    previous = t;
  }
  if (until - previous > best.gap_ms) best = { gap_ms: Math.round(until - previous), stalled_at: previous, back_at: null };
  return best;
}

/**
 * recoveryOf summarizes one page's samples around a fault. The fault runs from `faultStart` to `faultEnd`, and the page is watched
 * until `watchEnd`. Times in the result are seconds after the fault started, so runs of different faults line up.
 * @param {RecoverySample[]} samples
 * @param {{ faultStart: number, faultEnd: number, watchEnd: number }} window
 */
export function recoveryOf(samples, { faultStart, faultEnd, watchEnd }) {
  const seconds = (ms) => Math.round(ms / 100) / 10;
  // The window starts a little before the fault, so a stall that begins at the fault has a flow time to start from.
  const from = faultStart - 1000;
  const kinds = { audio: "fa", video: "fv" };
  const media = Object.fromEntries(
    Object.entries(kinds).map(([name, kind]) => {
      const gap = flowGap(samples, kind, from, watchEnd);
      const interrupted = gap.gap_ms > INTERRUPTION_MS;
      return [
        name,
        {
          interrupted,
          longest_gap_s: seconds(gap.gap_ms),
          // Seconds from the end of the fault to the first packet or frame after the interruption; null when it never came back, and
          // 0 when the flow resumed while the fault still held.
          back_after_fault_end_s: !interrupted ? null : gap.back_at === null ? null : seconds(Math.max(0, gap.back_at - faultEnd)),
          back_after_fault_start_s: !interrupted ? null : gap.back_at === null ? null : seconds(gap.back_at - faultStart),
          never_back: interrupted && gap.back_at === null,
        },
      ];
    }),
  );
  const statuses = [];
  for (const sample of samples) {
    if (sample.t < faultStart - 1000 || sample.t > watchEnd) continue;
    if (sample.status !== statuses.at(-1)?.status) statuses.push({ at_s: seconds(sample.t - faultStart), status: sample.status });
  }
  return { ...media, statuses };
}
