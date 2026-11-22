import type { SFUBootstrap } from "../media/types";
import type { ParticipantMediaAccess } from "./grant";

export function mediaBootstrap(media: ParticipantMediaAccess): SFUBootstrap {
  return media.clientPayload;
}
