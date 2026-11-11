import type { CloudflareSFUIceServer } from "../media/types";
import { directOrigin } from "../direct-path";
import { decodeBase64Url } from "./base64-url";
declare const syncCredentialBrand: unique symbol;
declare const mediaCredentialBrand: unique symbol;
const accessGrantBrand: unique symbol = Symbol("AccessGrant");
export type ParticipantSyncCredential = string & {
  readonly [syncCredentialBrand]: "chalk-sync";
};
export type ParticipantMediaCredential = string & {
  readonly [mediaCredentialBrand]: "chalk-media";
};
export type AccessSubject = {
  readonly tenantId: string;
  readonly spaceId: string;
  readonly episodeId: string;
  readonly participantId: string;
  readonly participantGeneration: number;
};
export type ParticipantSyncAccess = {
  readonly token: ParticipantSyncCredential;
  readonly expiresAt: string;
};
/** What the own SFU can do for this connection. A flag the server does not send as `true` is off. */
export type ChalkSFUCapabilities = {
  /** The SFU picks each subscriber's layer under the requested one, so a requested layer is a ceiling. */
  readonly serverLayerAdaptation: boolean;
  /** The SFU reports whether it delivers each remote video, and pauses one in place on request. */
  readonly subscriptionState: boolean;
  readonly iceRestart: boolean;
  /** The API reads the publication list and pulls the other Participants' audio in the first `tracks` request. */
  readonly pullPublished: boolean;
  /** The API serves every signaling call from the single `signal` route. */
  readonly unifiedSignaling: boolean;
  /** The SFU parks and resumes the caller's own camera or microphone in place, so a mute moves no SDP. */
  readonly muteInPlace: boolean;
  /** The https origin of the direct door for Sync and SFU signalling; absent when the API advertises none. */
  readonly directSignalingUrl?: string;
};
export type CloudflareSFUClientPayload = {
  readonly connectionId: string;
  readonly stunServer: string;
  readonly iceServers?: readonly CloudflareSFUIceServer[];
};
export type ChalkSFUClientPayload = {
  readonly connectionId: string;
  readonly episodeRef: string;
  /** Every ICE server the own SFU wants. It can be empty, because the SFU has a public address. */
  readonly iceServers: readonly CloudflareSFUIceServer[];
  readonly capabilities: ChalkSFUCapabilities;
};
export type ParticipantMediaAccess =
  | {
      readonly token: ParticipantMediaCredential;
      readonly expiresAt: string;
      readonly provider: "cloudflare_sfu";
      readonly clientPayload: CloudflareSFUClientPayload;
    }
  | {
      readonly token: ParticipantMediaCredential;
      readonly expiresAt: string;
      readonly provider: "chalk_sfu";
      readonly clientPayload: ChalkSFUClientPayload;
    };
export type ParsedAccessGrant = {
  readonly subject: AccessSubject;
  readonly episodeStartedAt?: string | null;
  readonly sync: ParticipantSyncAccess;
  readonly media: ParticipantMediaAccess;
};
/** Opaque signed envelope minted by the server SDK and consumed by SpaceClient. */
export type AccessGrant = {
  readonly [accessGrantBrand]: "AccessGrant";
};
export type AccessGrantProvider = () => ParsedAccessGrant | Promise<ParsedAccessGrant>;
export class AccessGrantError extends TypeError {
  readonly code = "access.invalid" as const;
  constructor(
    message = "Access grant is invalid",
    readonly reason?: "connection_superseded",
  ) {
    super(message);
    this.name = "AccessGrantError";
  }
}
class AccessUnavailableError extends Error {
  readonly code = "access.unavailable" as const;
  constructor(status: number) {
    super(`Access grant request failed with HTTP ${status}`);
    this.name = "AccessUnavailableError";
  }
}
async function requireSuccessfulResponse(response: Response): Promise<void> {
  if (response.ok) return;
  const status = response.status;
  if (status === 408 || status === 425 || status === 429 || status >= 500) throw new AccessUnavailableError(status);
  if (status === 409) {
    const body: unknown = await response.json().catch(() => null);
    const code = conflictResponseCode(body);
    if (code === "participant.media_replacement_pending") throw new AccessUnavailableError(status);
    if (code === "participant.connection_superseded") throw new AccessGrantError(undefined, "connection_superseded");
  }
  throw new AccessGrantError(`Access grant request failed with HTTP ${status}`);
}
function conflictResponseCode(body: unknown): unknown {
  return typeof body === "object" && body !== null && "error" in body && typeof body.error === "object" && body.error !== null && "code" in body.error ? body.error.code : undefined;
}
export function parseParsedAccessGrant(value: unknown): ParsedAccessGrant {
  if (!isRecord(value)) throw new AccessGrantError();
  const subject = parseSubject(value.subject);
  const episodeStartedAt = parseOptionalDateTime(value.episode_started_at);
  return {
    subject,
    episodeStartedAt,
    sync: parseSyncAccess(value.sync),
    media: parseMediaAccess(value.media),
  };
}
export function parseAccessGrant(value: unknown): AccessGrant {
  return accessGrantFromParsed(parseParsedAccessGrant(value));
}
export function accessGrantFromParsed(value: ParsedAccessGrant): AccessGrant {
  return Object.freeze({
    subject: {
      tenant_id: value.subject.tenantId,
      space_id: value.subject.spaceId,
      episode_id: value.subject.episodeId,
      participant_id: value.subject.participantId,
      participant_generation: value.subject.participantGeneration,
    },
    ...(value.episodeStartedAt ? { episode_started_at: value.episodeStartedAt } : {}),
    sync: { token: value.sync.token, expires_at: value.sync.expiresAt },
    media: {
      token: value.media.token,
      expires_at: value.media.expiresAt,
      provider: value.media.provider,
      client_payload: mediaClientPayload(value.media),
    },
    [accessGrantBrand]: "AccessGrant" as const,
  });
}
export async function requireParsedAccessGrant(value: unknown): Promise<ParsedAccessGrant> {
  if (typeof Response !== "undefined" && value instanceof Response) {
    await requireSuccessfulResponse(value);
    try {
      return parseParsedAccessGrant(await value.json());
    } catch (error) {
      if (error instanceof AccessGrantError) throw error;
      throw new AccessGrantError();
    }
  }
  return parseParsedAccessGrant(value);
}
export async function requireAccessGrant(value: unknown): Promise<AccessGrant> {
  if (typeof Response !== "undefined" && value instanceof Response) {
    await requireSuccessfulResponse(value);
    try {
      return parseAccessGrant(await value.json());
    } catch (error) {
      if (error instanceof AccessGrantError) throw error;
      throw new AccessGrantError();
    }
  }
  return parseAccessGrant(value);
}
export function isParsedAccessGrant(value: unknown): value is ParsedAccessGrant {
  try {
    parseParsedAccessGrant(value);
    return true;
  } catch {
    return false;
  }
}
function parseSubject(value: unknown): AccessSubject {
  if (!isRecord(value)) throw new AccessGrantError();
  return {
    tenantId: requireNonEmptyString(value.tenant_id),
    spaceId: requireNonEmptyString(value.space_id),
    episodeId: requireNonEmptyString(value.episode_id),
    participantId: requireNonEmptyString(value.participant_id),
    participantGeneration: requirePositiveInteger(value.participant_generation),
  };
}
function requirePositiveInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new AccessGrantError();
  return value;
}
function parseSyncAccess(value: unknown): ParticipantSyncAccess {
  if (!isRecord(value)) throw new AccessGrantError();
  return {
    token: requireCredential(value.token, "chalk-sync") as ParticipantSyncCredential,
    expiresAt: requireDateTime(value.expires_at ?? value.expiresAt),
  };
}
function parseMediaAccess(value: unknown): ParticipantMediaAccess {
  if (!isRecord(value)) throw new AccessGrantError();
  const payload = value.client_payload ?? value.clientPayload;
  if (!isRecord(payload)) throw new AccessGrantError();
  const token = requireCredential(value.token, "chalk-media") as ParticipantMediaCredential;
  const expiresAt = requireDateTime(value.expires_at ?? value.expiresAt);
  switch (value.provider) {
    case "cloudflare_sfu":
      return { token, expiresAt, provider: value.provider, clientPayload: parseCloudflareSFUPayload(payload) };
    case "chalk_sfu":
      return { token, expiresAt, provider: value.provider, clientPayload: parseChalkSFUPayload(payload) };
    default:
      throw new AccessGrantError();
  }
}
function parseCloudflareSFUPayload(payload: Readonly<Record<string, unknown>>): CloudflareSFUClientPayload {
  const iceServers = payload.iceServers === undefined || payload.iceServers === null ? {} : { iceServers: parseIceServers(payload.iceServers) };
  return { connectionId: requireNonEmptyString(payload.connectionId), stunServer: requireNonEmptyString(payload.stunServer), ...iceServers };
}
function parseChalkSFUPayload(payload: Readonly<Record<string, unknown>>): ChalkSFUClientPayload {
  return {
    connectionId: requireNonEmptyString(payload.connectionId),
    episodeRef: requireNonEmptyString(payload.episodeRef),
    iceServers: parseIceServers(payload.iceServers ?? []),
    capabilities: parseChalkSFUCapabilities(payload.capabilities),
  };
}
function parseChalkSFUCapabilities(value: unknown): ChalkSFUCapabilities {
  const flags = isRecord(value) ? value : {};
  const direct = directOrigin(flags.directSignalingUrl);
  return {
    serverLayerAdaptation: flags.serverLayerAdaptation === true,
    subscriptionState: flags.subscriptionState === true,
    iceRestart: flags.iceRestart === true,
    pullPublished: flags.pullPublished === true,
    unifiedSignaling: flags.unifiedSignaling === true,
    muteInPlace: flags.muteInPlace === true,
    ...(direct ? { directSignalingUrl: direct.origin } : {}),
  };
}
function parseIceServers(value: unknown): readonly CloudflareSFUIceServer[] {
  if (!Array.isArray(value)) throw new AccessGrantError();
  return value.map((entry): CloudflareSFUIceServer => {
    if (!isRecord(entry) || !Array.isArray(entry.urls) || entry.urls.length === 0) throw new AccessGrantError();
    const urls = entry.urls.map(requireNonEmptyString);
    if (entry.username === undefined && entry.credential === undefined) return { urls };
    return { urls, username: requireNonEmptyString(entry.username), credential: requireNonEmptyString(entry.credential) };
  });
}
function mediaClientPayload(value: ParticipantMediaAccess): Readonly<Record<string, unknown>> {
  switch (value.provider) {
    case "cloudflare_sfu":
      return {
        connectionId: value.clientPayload.connectionId,
        stunServer: value.clientPayload.stunServer,
        ...(value.clientPayload.iceServers ? { iceServers: value.clientPayload.iceServers } : {}),
      };
    case "chalk_sfu":
      return {
        connectionId: value.clientPayload.connectionId,
        episodeRef: value.clientPayload.episodeRef,
        iceServers: value.clientPayload.iceServers,
        capabilities: value.clientPayload.capabilities,
      };
  }
}
function requireCredential(value: unknown, audience: "chalk-sync" | "chalk-media"): string {
  const token = requireNonEmptyString(value);
  const segments = token.split(".");
  if (segments.length !== 3) throw new AccessGrantError();
  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64Url(segments[1] ?? ""));
  } catch {
    throw new AccessGrantError();
  }
  if (!isRecord(payload) || payload.aud !== audience) throw new AccessGrantError();
  return token;
}
function requireDateTime(value: unknown): string {
  const dateTime = requireNonEmptyString(value);
  if (!Number.isFinite(Date.parse(dateTime))) throw new AccessGrantError();
  return dateTime;
}
function parseOptionalDateTime(value: unknown): string | null {
  if (typeof value !== "string" || value.trim() === "" || !Number.isFinite(Date.parse(value))) return null;
  return value;
}
function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new AccessGrantError();
  return value;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
