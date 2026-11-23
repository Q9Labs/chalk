import { ConnectionAccessFailure } from "../access/manager";
import { SFUError } from "../media";
import { arrivalErrorCode } from "../public-invites/entrance.js";

/** The media API refused the credential. */
export function sfuAccessRejected(cause: unknown): boolean {
  return cause instanceof SFUError && (cause.options.status === 401 || cause.options.status === 403);
}

/** A media call was refused: the API refused the credential, or the refresh that followed found the access invalid (the Episode is over). */
export function mediaAccessRejected(cause: unknown): boolean {
  return sfuAccessRejected(cause) || (cause instanceof ConnectionAccessFailure && cause.code === "access.invalid");
}

/** A public guest's refresh was answered `episode.not_active`. */
export function episodeNoLongerActive(cause: unknown): boolean {
  return arrivalErrorCode(cause) === "episode.not_active";
}
