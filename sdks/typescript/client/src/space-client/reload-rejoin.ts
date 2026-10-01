import { Schema } from "effect";
import { parseParsedAccessGrant, requireAccessGrant, type AccessGrant } from "../access/grant";

/** A tab-scoped, two-minute recovery hint, never an admission credential by itself. */
export type ReloadRejoinMarker = {
  readonly version: 1;
  readonly expiresAt: number;
  readonly space: string;
  readonly episodeId: string;
  readonly participantId: string;
  readonly displayName: string;
  readonly microphone: boolean;
  readonly camera: boolean;
  readonly mediaProof: string;
  readonly arrivalHandle?: string;
  readonly tenantId?: string;
  readonly participantGeneration: number;
};

const reloadMarkerSchema = Schema.Struct({
  version: Schema.Literal(1),
  expiresAt: Schema.Number,
  space: Schema.String,
  episodeId: Schema.String,
  participantId: Schema.String,
  displayName: Schema.String,
  microphone: Schema.Boolean,
  camera: Schema.Boolean,
  mediaProof: Schema.String,
  arrivalHandle: Schema.optional(Schema.String),
  tenantId: Schema.optional(Schema.String),
  participantGeneration: Schema.Number,
});

export const reloadRejoinStorageKey = "chalk.reload-rejoin";
export const reloadRejoinLifetimeMs = 120_000;

export function readReloadRejoin(storage: Pick<Storage, "getItem" | "removeItem">, space: string, now = Date.now()): ReloadRejoinMarker | null {
  const encoded = storage.getItem(reloadRejoinStorageKey);
  // Consume before any network request: a failed attempt must not loop on reload.
  storage.removeItem(reloadRejoinStorageKey);
  if (!encoded) return null;
  try {
    const value = Schema.decodeUnknownSync(reloadMarkerSchema)(JSON.parse(encoded));
    if (
      value.expiresAt <= now ||
      value.expiresAt > now + reloadRejoinLifetimeMs ||
      value.space !== space ||
      !value.episodeId ||
      !value.participantId ||
      !value.mediaProof ||
      !Number.isSafeInteger(value.participantGeneration) ||
      value.participantGeneration < 1 ||
      (!value.arrivalHandle && !value.tenantId)
    )
      return null;
    return value;
  } catch {
    return null;
  }
}

export function writeReloadRejoin(storage: Pick<Storage, "setItem">, marker: Omit<ReloadRejoinMarker, "version" | "expiresAt">, now = Date.now()): void {
  storage.setItem(reloadRejoinStorageKey, JSON.stringify({ ...marker, version: 1, expiresAt: now + reloadRejoinLifetimeMs }));
}

/** Refuse a fresh Episode or Participant even if an integration returns a new grant. */
export async function resumeReloadRejoin(marker: ReloadRejoinMarker, refresh: () => Promise<unknown>): Promise<AccessGrant> {
  const access = await requireAccessGrant(await refresh());
  const subject = parseParsedAccessGrant(access).subject;
  if (subject.episodeId !== marker.episodeId || subject.participantId !== marker.participantId || subject.participantGeneration !== marker.participantGeneration) throw new Error("Reload access no longer belongs to this Participant.");
  return access;
}

export function reloadRejoinAccess(access: unknown): Pick<ReloadRejoinMarker, "episodeId" | "participantId" | "participantGeneration" | "mediaProof"> {
  const parsed = parseParsedAccessGrant(access);
  return { episodeId: parsed.subject.episodeId, participantId: parsed.subject.participantId, participantGeneration: parsed.subject.participantGeneration, mediaProof: parsed.media.token };
}
