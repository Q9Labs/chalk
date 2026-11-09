import type { CloudflareSFUBootstrap } from "../media/types";
import type { ParticipantMediaAccess } from "./grant";

/**
 * The media engine's bootstrap for a grant. Each provider maps on its own, and
 * a provider this SDK does not know throws, so it never runs as Cloudflare.
 */
export function mediaBootstrap(media: ParticipantMediaAccess): CloudflareSFUBootstrap {
  switch (media.provider) {
    case "cloudflare_sfu":
      return media.clientPayload;
    case "chalk_sfu":
      return {
        connectionId: media.clientPayload.connectionId,
        iceServers: media.clientPayload.iceServers,
        capabilities: {
          serverLayerAdaptation: media.clientPayload.capabilities.serverLayerAdaptation,
          subscriptionState: media.clientPayload.capabilities.subscriptionState,
          iceRestart: media.clientPayload.capabilities.iceRestart,
          pullPublished: media.clientPayload.capabilities.pullPublished,
          unifiedSignaling: media.clientPayload.capabilities.unifiedSignaling,
        },
      };
    default:
      return unsupportedProvider(media);
  }
}

function unsupportedProvider(media: never): never {
  throw new TypeError("This SDK cannot run the grant's media provider", { cause: media });
}
