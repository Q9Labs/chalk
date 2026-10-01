// Keep the full camera encoding usable when sending the extra layer would
// starve it. Recovery needs five consecutive healthy one-second samples.
export class CameraUplinkPolicy {
  #healthySamples = 0;

  sample(bitrate: number | undefined, lowActive: boolean): boolean {
    if (bitrate === undefined || !Number.isFinite(bitrate) || bitrate <= 0) {
      this.reset();
      return lowActive;
    }
    if (bitrate < 1_500_000) {
      this.reset();
      return false;
    }
    if (lowActive) {
      this.reset();
      return true;
    }
    if (bitrate < 2_000_000) {
      this.reset();
      return false;
    }
    return ++this.#healthySamples >= 5;
  }

  reset(): void {
    this.#healthySamples = 0;
  }
}

export function cameraUplinkBitrate(stats: Iterable<{ readonly type?: string; readonly state?: string; readonly nominated?: boolean; readonly selected?: boolean; readonly availableOutgoingBitrate?: number }>): number | undefined {
  for (const stat of stats) {
    if (stat.type === "candidate-pair" && stat.state === "succeeded" && (stat.nominated || stat.selected)) return stat.availableOutgoingBitrate;
  }
  return undefined;
}
