import { sha256Hex } from "../obs/sha256";
import type { TelemetryEvent, TelemetrySink } from "../telemetry/types";
import { deviceFailedEvent } from "./capture-error";
import { parseCloudflareSFUPublicationID } from "./tracks";

type AudioClaim = NonNullable<TelemetryEvent["audio_observation"]>;
type Sink = Pick<TelemetrySink, "record"> | undefined;
export type AudioTrack = { readonly participantId?: string; readonly trackName: string; readonly connectionId: string };

export function recordAudio(telemetry: Sink, claim: AudioClaim, track?: AudioTrack, sampleMs?: number): void {
  telemetry?.record({
    type: "audio_observed",
    audio_observation: claim,
    ...(sampleMs !== undefined ? { audio_sample_ms: sampleMs } : {}),
    ...(track ? { audio_track_key: sha256Hex(`${track.connectionId}\0${track.trackName}`) } : {}),
    ...(track?.participantId ? { audio_peer_id: track.participantId } : {}),
  });
}

export function remoteAudioTrack(participantId: string, publicationId: string): AudioTrack | undefined {
  try {
    return { participantId, ...parseCloudflareSFUPublicationID(publicationId) };
  } catch {
    // Do not attach a failure on an unrecognized publication to an arbitrary track.
    return undefined;
  }
}

export async function observeMicrophoneCapture(telemetry: Sink, constraints: MediaStreamConstraints, run: () => Promise<MediaStream>, signal?: AbortSignal): Promise<MediaStream> {
  if (!telemetry || !constraints.audio) return run();
  recordAudio(telemetry, typeof constraints.audio === "object" && constraints.audio.deviceId ? "selected_input" : "default_input");

  try {
    const stream = await run();
    if (!signal?.aborted) recordAudio(telemetry, stream.getTracks().some((track) => track.kind === "audio" && track.readyState === "live") ? "capture_live" : "capture_missing");
    return stream;
  } catch (error) {
    // A failed combined request does not say whether the microphone or camera was denied.
    if (!constraints.video && !signal?.aborted) {
      const { error_name: name } = deviceFailedEvent(error, "microphone");
      if (name === "NotAllowedError") recordAudio(telemetry, "capture_denied");
      else if (name === "NotFoundError" || name === "OverconstrainedError") recordAudio(telemetry, "input_unavailable");
      else if (name !== "AbortError") recordAudio(telemetry, "capture_failed");
    }
    throw error;
  }
}
