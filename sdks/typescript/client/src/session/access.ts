import type { CloudflareSFUBootstrap } from "../media";

declare const syncCredentialBrand: unique symbol;
declare const mediaCredentialBrand: unique symbol;

export type ParticipantSyncCredential = string & { readonly [syncCredentialBrand]: "chalk-sync" };
export type ParticipantMediaCredential = string & { readonly [mediaCredentialBrand]: "chalk-media" };

export type ParticipantAccessSubject = {
  readonly tenantId: string;
  readonly roomId: string;
  readonly sessionId: string;
  readonly participantSessionId: string;
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
  readonly clientPayload: CloudflareSFUBootstrap;
};

export type ParticipantAccess = {
  readonly subject: ParticipantAccessSubject;
  readonly sync: ParticipantSyncAccess;
  readonly media: ParticipantMediaAccess;
};

export type ParticipantAccessProvider = () => ParticipantAccess | Promise<ParticipantAccess>;

export class ParticipantAccessError extends TypeError {
  readonly code = "invalid_participant_access" as const;

  constructor(message = "Participant access is invalid") {
    super(message);
    this.name = "ParticipantAccessError";
  }
}

export function parseParticipantAccess(value: unknown): ParticipantAccess {
  if (!isRecord(value)) throw new ParticipantAccessError();
  return {
    subject: parseSubject(value.subject),
    sync: parseSyncAccess(value.sync),
    media: parseMediaAccess(value.media),
  };
}

export async function requireParticipantAccess(value: unknown): Promise<ParticipantAccess> {
  if (typeof Response !== "undefined" && value instanceof Response) {
    if (!value.ok) throw new ParticipantAccessError(`Participant access request failed with HTTP ${value.status}`);
    try {
      return parseParticipantAccess(await value.json());
    } catch (error) {
      if (error instanceof ParticipantAccessError) throw error;
      throw new ParticipantAccessError();
    }
  }
  return parseParticipantAccess(value);
}

export function isParticipantAccess(value: unknown): value is ParticipantAccess {
  try {
    parseParticipantAccess(value);
    return true;
  } catch {
    return false;
  }
}

function parseSubject(value: unknown): ParticipantAccessSubject {
  if (!isRecord(value)) throw new ParticipantAccessError();
  const participantGeneration = value.participantGeneration;
  if (!Number.isSafeInteger(participantGeneration) || (participantGeneration as number) < 1) throw new ParticipantAccessError();

  return {
    tenantId: requireNonEmptyString(value.tenantId),
    roomId: requireNonEmptyString(value.roomId),
    sessionId: requireNonEmptyString(value.sessionId),
    participantSessionId: requireNonEmptyString(value.participantSessionId),
    participantGeneration: participantGeneration as number,
  };
}

function parseSyncAccess(value: unknown): ParticipantSyncAccess {
  if (!isRecord(value)) throw new ParticipantAccessError();
  return {
    token: requireCredential(value.token, "chalk-sync") as ParticipantSyncCredential,
    expiresAt: requireDateTime(value.expiresAt),
  };
}

function parseMediaAccess(value: unknown): ParticipantMediaAccess {
  if (!isRecord(value) || value.provider !== "cloudflare_sfu" || !isRecord(value.clientPayload)) throw new ParticipantAccessError();
  return {
    token: requireCredential(value.token, "chalk-media") as ParticipantMediaCredential,
    expiresAt: requireDateTime(value.expiresAt),
    provider: value.provider,
    clientPayload: {
      connectionId: requireNonEmptyString(value.clientPayload.connectionId),
      stunServer: requireNonEmptyString(value.clientPayload.stunServer),
    },
  };
}

function requireCredential(value: unknown, audience: "chalk-sync" | "chalk-media"): string {
  const token = requireNonEmptyString(value);
  const segments = token.split(".");
  if (segments.length !== 3) throw new ParticipantAccessError();

  let payload: unknown;
  try {
    payload = JSON.parse(decodeBase64URL(segments[1] ?? ""));
  } catch {
    throw new ParticipantAccessError();
  }
  if (!isRecord(payload) || payload.aud !== audience) throw new ParticipantAccessError();
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
  if (!Number.isFinite(Date.parse(dateTime))) throw new ParticipantAccessError();
  return dateTime;
}

function requireNonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new ParticipantAccessError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
