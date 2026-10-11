import type { AccessContext } from "../space-client/types.js";
import type { IssueAccessGrantInput } from "./types.js";
import { parseParsedAccessGrant, type AccessGrant, type ParticipantMediaCredential } from "../access/grant.js";

/** Forward the browser request unchanged; only Chalk decides whether media needs replacing. */
export type AccessRefreshRequest = Pick<AccessContext, "replaceMediaConnection">;

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

export function accessRefreshInput(state: IssueAccessGrantInput, request?: AccessRefreshRequest): IssueAccessGrantInput {
  if (request?.replaceMediaConnection === true) return { participantGeneration: state.participantGeneration, replaceMediaConnection: true };
  return state;
}
