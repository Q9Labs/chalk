// The camera publishes two simulcast layers: h (full size) and l (half size).
// Below STARVED_BITRATE the full-size layer cannot be sent at all, and WebKit
// does not shrink it to fit, so l stays on: it is the only layer that can
// carry video. Between STARVED_BITRATE and PAUSE_FROM_BITRATE nothing changes,
// which keeps an estimate hovering near the edge from toggling the layer.
// From PAUSE_FROM_BITRATE up to PAUSE_BELOW_BITRATE the budget is expected to
// fit h alone, so l is paused to give h the whole uplink after
// CONSECUTIVE_SAMPLES one-second samples in that band, and restored the same
// way once the estimate stays at or above RESTORE_BITRATE.
const STARVED_BITRATE = 1_000_000;
const PAUSE_FROM_BITRATE = 1_200_000;
const PAUSE_BELOW_BITRATE = 1_500_000;
const RESTORE_BITRATE = 2_000_000;
const CONSECUTIVE_SAMPLES = 5;

export class CameraUplinkPolicy {
  #samples = 0;

  sample(bitrate: number | undefined, lowActive: boolean): boolean {
    if (bitrate === undefined || !Number.isFinite(bitrate) || bitrate <= 0) {
      this.reset();
      return lowActive;
    }
    if (bitrate < STARVED_BITRATE) {
      this.reset();
      return true;
    }
    const wantsFlip = lowActive ? bitrate >= PAUSE_FROM_BITRATE && bitrate < PAUSE_BELOW_BITRATE : bitrate >= RESTORE_BITRATE;
    if (!wantsFlip) {
      this.reset();
      return lowActive;
    }
    if (++this.#samples < CONSECUTIVE_SAMPLES) return lowActive;
    this.reset();
    return !lowActive;
  }

  reset(): void {
    this.#samples = 0;
  }
}

export function cameraUplinkBitrate(stats: Iterable<{ readonly type?: string; readonly state?: string; readonly nominated?: boolean; readonly selected?: boolean; readonly availableOutgoingBitrate?: number }>): number | undefined {
  for (const stat of stats) {
    if (stat.type === "candidate-pair" && stat.state === "succeeded" && (stat.nominated || stat.selected)) return stat.availableOutgoingBitrate;
  }
  return undefined;
}
