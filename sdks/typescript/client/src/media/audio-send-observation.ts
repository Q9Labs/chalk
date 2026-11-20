import type { TelemetrySink } from "../telemetry/types";
import { recordAudio, type AudioTrack } from "./audio-observation";

type Sample = { trackName: string; id: string; at: number; bytes: number; energy: number | undefined; duration: number | undefined };

export class AudioSendObservation {
  #previous: Sample | undefined;

  constructor(private readonly telemetry: Pick<TelemetrySink, "record"> | undefined) {}

  sample(report: RTCStatsReport, track: MediaStreamTrack | undefined, publication: AudioTrack | undefined): void {
    if (!this.telemetry || !track?.enabled || track.muted || track.readyState !== "live" || !publication) {
      this.#previous = undefined;
      return;
    }
    for (const rtp of report.values()) {
      if (rtp.type !== "outbound-rtp" || rtp.kind !== "audio" || typeof rtp.bytesSent !== "number" || typeof rtp.mediaSourceId !== "string") continue;
      const source = report.get(rtp.mediaSourceId);
      if (source?.type !== "media-source" || source.trackIdentifier !== track.id) continue;
      const current: Sample = {
        trackName: publication.trackName,
        id: rtp.id,
        at: rtp.timestamp,
        bytes: rtp.bytesSent,
        energy: typeof source.totalAudioEnergy === "number" ? source.totalAudioEnergy : undefined,
        duration: typeof source.totalSamplesDuration === "number" ? source.totalSamplesDuration : undefined,
      };
      const previous = this.#previous;
      if (previous?.trackName === current.trackName && previous.id === current.id && current.bytes >= previous.bytes) {
        const elapsed = Math.floor(current.at - previous.at);
        if (elapsed < 5_000 && elapsed >= 0) return;
        if (elapsed >= 5_000 && elapsed <= 60_000) {
          const signal = hasSignal(previous, current);
          if (current.bytes > previous.bytes) recordAudio(this.telemetry, signal ? "outbound_signal" : "outbound_flowing", publication, elapsed);
          else if (signal) recordAudio(this.telemetry, "capture_signal_no_outbound", publication, elapsed);
        }
      }
      this.#previous = current;
      return;
    }
    this.#previous = undefined;
  }
}

function hasSignal(previous: Sample, current: Sample): boolean {
  if (previous.energy === undefined || current.energy === undefined || previous.duration === undefined || current.duration === undefined) return false;
  const duration = current.duration - previous.duration;
  // A measured signal above -50 dBFS is not proof of speech.
  return duration > 0 && (current.energy - previous.energy) / duration > 0.00001;
}
