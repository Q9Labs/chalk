import { ConnectionAccessFailure } from "../access/manager";
import { SFUError } from "../media";
import { arrivalErrorCode } from "../public-invites/entrance.js";

/** The media API refused the credential. */
export function sfuAccessRejected(cause: unknown): boolean {
  return cause instanceof SFUError && (cause.options.status === 401 || cause.options.status === 403);
}

/** The HTTP status of a refusal from Chalk's media signalling. A 401 or 403 is an access problem and a retryable status is recovery, so neither counts. */
export function mediaRefusalStatus(cause: unknown): number | undefined {
  if (!(cause instanceof SFUError)) return undefined;
  const { status, retryableConnection } = cause.options;
  return status !== undefined && status >= 400 && status < 500 && status !== 401 && status !== 403 && !retryableConnection ? status : undefined;
}

/** A media call was refused: the API refused the credential, or the refresh that followed found the access invalid (the Episode is over). */
export function mediaAccessRejected(cause: unknown): boolean {
  return sfuAccessRejected(cause) || (cause instanceof ConnectionAccessFailure && cause.code === "access.invalid");
}

/** A public guest's refresh was answered `episode.not_active`. */
export function episodeNoLongerActive(cause: unknown): boolean {
  return arrivalErrorCode(cause) === "episode.not_active";
}
