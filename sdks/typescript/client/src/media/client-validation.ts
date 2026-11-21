import { SFUError } from "./types";
import type { SFUBootstrap, SFUClientOptions } from "./types";
import type { MediaPublicationSource } from "./plane";

export function validateClientOptions(options: SFUClientOptions): void {
  validateBootstrap(options.bootstrap);
  if (!options.participantId.trim()) throw new SFUError("Chalk SFU participant is missing", "invalid_bootstrap");
  if (invalidDuration(options.pollIntervalMs)) throw new SFUError("Chalk SFU polling interval is invalid", "invalid_bootstrap");
  if (invalidDuration(options.unreportedVideoTileWaitMs)) throw new SFUError("Chalk SFU unreported video tile wait is invalid", "invalid_bootstrap");
}

export function invalidDuration(ms: number | undefined): boolean {
  return ms !== undefined && (!Number.isFinite(ms) || ms < 0);
}

export function validateBootstrap(bootstrap: SFUBootstrap): void {
  if (!bootstrap.connectionId.trim()) throw new SFUError("Chalk SFU bootstrap is incomplete", "invalid_bootstrap");
}

export function validateTrackSource(source: MediaPublicationSource, track: MediaStreamTrack): void {
  const valid = source === "microphone" || source === "screen_audio" ? track.kind === "audio" : track.kind === "video";
  if (!valid) throw new SFUError(`The prepared ${source} track has an incompatible kind`, "media_failed");
}
