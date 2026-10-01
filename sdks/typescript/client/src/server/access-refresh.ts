import { parseParsedAccessGrant, type AccessGrant, type ParticipantMediaCredential } from "../access/grant.js";

/** Keep this on your backend, scoped to the authenticated Participant. Never send it to a browser or log it. */
export type AccessRefreshState = {
  readonly participantGeneration: number;
  readonly currentMediaToken: ParticipantMediaCredential;
};

/** Retain after admission and every issueAccess response; pass directly to participants.issueAccess for refresh. */
export function getAccessRefreshState(access: AccessGrant): AccessRefreshState {
  const grant = parseParsedAccessGrant(access);
  return Object.freeze({
    participantGeneration: grant.subject.participantGeneration,
    currentMediaToken: grant.media.token,
  });
}
