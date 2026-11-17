import { CloudflareSFUError } from "./types";
import type { CloudflareSFUBootstrap, CloudflareSFUClientOptions } from "./types";
import type { MediaPublicationSource } from "./plane";

export function validateClientOptions(options: CloudflareSFUClientOptions): void {
  validateBootstrap(options.bootstrap);
  if (!options.participantId.trim()) throw new CloudflareSFUError("Cloudflare SFU participant is missing", "invalid_bootstrap");
  if (invalidDuration(options.pollIntervalMs)) throw new CloudflareSFUError("Cloudflare SFU polling interval is invalid", "invalid_bootstrap");
  if (invalidDuration(options.unreportedVideoTileWaitMs)) throw new CloudflareSFUError("Cloudflare SFU unreported video tile wait is invalid", "invalid_bootstrap");
}

export function invalidDuration(ms: number | undefined): boolean {
  return ms !== undefined && (!Number.isFinite(ms) || ms < 0);
}

export function validateBootstrap(bootstrap: CloudflareSFUBootstrap): void {
  if (!bootstrap.connectionId.trim() || (bootstrap.stunServer !== undefined && !bootstrap.stunServer.trim())) throw new CloudflareSFUError("Cloudflare SFU bootstrap is incomplete", "invalid_bootstrap");
}

export function validateTrackSource(source: MediaPublicationSource, track: MediaStreamTrack): void {
  const valid = source === "microphone" || source === "screen_audio" ? track.kind === "audio" : track.kind === "video";
  if (!valid) throw new CloudflareSFUError(`The prepared ${source} track has an incompatible kind`, "media_failed");
}
