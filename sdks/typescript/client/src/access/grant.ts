declare const syncCredentialBrand: unique symbol;
declare const mediaCredentialBrand: unique symbol;
const accessGrantBrand: unique symbol = Symbol("AccessGrant");

export type ParticipantSyncCredential = string & { readonly [syncCredentialBrand]: "chalk-sync" };
export type ParticipantMediaCredential = string & { readonly [mediaCredentialBrand]: "chalk-media" };

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

export type ParticipantMediaAccess = {
  readonly token: ParticipantMediaCredential;
  readonly expiresAt: string;
  readonly provider: "cloudflare_sfu";
  readonly clientPayload: {
    readonly connectionId: string;
    readonly stunServer: string;
  };
};

export type ParsedAccessGrant = {
  readonly subject: AccessSubject;
  readonly sync: ParticipantSyncAccess;
  readonly media: ParticipantMediaAccess;
};

/** Opaque signed envelope minted by the server SDK and consumed by SpaceClient. */
export type AccessGrant = { readonly [accessGrantBrand]: "AccessGrant" };

export type AccessGrantProvider = () => ParsedAccessGrant | Promise<ParsedAccessGrant>;

export class AccessGrantError extends TypeError {
  readonly code = "access.invalid" as const;

  constructor(message = "Access grant is invalid") {
    super(message);
    this.name = "AccessGrantError";
  }
}

export function parseParsedAccessGrant(value: unknown): ParsedAccessGrant {
  if (!isRecord(value)) throw new AccessGrantError();
  return {
    subject: parseSubject(value.subject),
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
    sync: { token: value.sync.token, expires_at: value.sync.expiresAt },
    media: {
      token: value.media.token,
      expires_at: value.media.expiresAt,
      provider: value.media.provider,
      client_payload: { ...value.media.clientPayload },
    },
    [accessGrantBrand]: "AccessGrant" as const,
  });
}

export async function requireParsedAccessGrant(value: unknown): Promise<ParsedAccessGrant> {
  if (typeof Response !== "undefined" && value instanceof Response) {
    if (!value.ok) throw new AccessGrantError(`Access grant request failed with HTTP ${value.status}`);
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
    if (!value.ok) throw new AccessGrantError(`Access grant request failed with HTTP ${value.status}`);
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
  if (!isRecord(value) || value.provider !== "cloudflare_sfu" || !isRecord(value.client_payload ?? value.clientPayload)) throw new AccessGrantError();
  const payload = (value.client_payload ?? value.clientPayload) as Record<string, unknown>;
  return {
    token: requireCredential(value.token, "chalk-media") as ParticipantMediaCredential,
    expiresAt: requireDateTime(value.expires_at ?? value.expiresAt),
    provider: value.provider,
    clientPayload: {
      connectionId: requireNonEmptyString(payload.connectionId),
      stunServer: requireNonEmptyString(payload.stunServer),
    },
  };
}

function requireCredential(value: unknown, audience: "chalk-sync" | "chalk-media"): string {
  const token = requireNonEmptyString(value);
  const segments = token.split(".");
  if (segments.length !== 3) throw new AccessGrantError();

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64URL(segments[1] ?? ""));
  } catch {
    throw new AccessGrantError();
  }
  if (!isRecord(payload) || payload.aud !== audience) throw new AccessGrantError();
  return token;
}

function decodeBase64URL(value: string): string {
  const base64 = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function requireDateTime(value: unknown): string {
  const dateTime = requireNonEmptyString(value);
  if (!Number.isFinite(Date.parse(dateTime))) throw new AccessGrantError();
  return dateTime;
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new AccessGrantError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
