import type { V3MediaSource } from "../sync/v3-types";
import { CloudflareSFUError } from "./types";
import type { CloudflareSFUPublication, CloudflareSFUPublicationSnapshot, CloudflareSFUSessionDescription } from "./types";

export type PublicationCursor = {
  readonly incarnation: number;
  readonly sequence: number;
  readonly signature: string;
};

export function parseCloudflareSFUPublicationID(publicationId: string): { readonly sessionId: string; readonly trackName: string } {
  if (publicationId.startsWith("chalk_pub_v1.")) return parseVersionOnePublicationReference(publicationId.slice("chalk_pub_v1.".length));
  if (publicationId.startsWith("chalk_pub_")) throw new CloudflareSFUError("Cloudflare SFU publication ID uses an unsupported version", "invalid_publication");
  return parseLegacyPublicationReference(publicationId);
}

function parseVersionOnePublicationReference(encoded: string): { readonly sessionId: string; readonly trackName: string } {
  if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded) || encoded.length % 4 === 1) {
    throw new CloudflareSFUError("Cloudflare SFU publication ID is malformed", "invalid_publication");
  }
  try {
    const standard = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const padded = standard.padEnd(standard.length + ((4 - (standard.length % 4)) % 4), "=");
    const binary = globalThis.atob(padded);
    const canonical = globalThis.btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
    if (canonical !== encoded) throw new Error("non-canonical publication payload");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isVersionOnePublicationPayload(decoded)) throw new Error("invalid publication payload");
    return { sessionId: decoded.c, trackName: decoded.t };
  } catch {
    throw new CloudflareSFUError("Cloudflare SFU publication ID is malformed", "invalid_publication");
  }
}

function isVersionOnePublicationPayload(value: unknown): value is { readonly c: string; readonly m: string; readonly t: string; readonly g: number } {
  if (!isRecord(value) || !hasExactKeys(value, ["c", "g", "m", "t"])) return false;
  return isTrimmedNonEmptyString(value.c) && isTrimmedNonEmptyString(value.m) && isTrimmedNonEmptyString(value.t) && isPositiveSafeInteger(value.g);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isTrimmedNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseLegacyPublicationReference(publicationId: string): { readonly sessionId: string; readonly trackName: string } {
  const separator = publicationId.indexOf("|");
  if (separator <= 0 || separator === publicationId.length - 1 || publicationId.indexOf("|", separator + 1) !== -1) {
    throw new CloudflareSFUError("Cloudflare SFU publication ID is malformed", "invalid_publication");
  }
  const sessionId = publicationId.slice(0, separator);
  const trackName = publicationId.slice(separator + 1);
  if (sessionId.trim() !== sessionId || trackName.trim() !== trackName) throw new CloudflareSFUError("Cloudflare SFU publication ID is malformed", "invalid_publication");
  return { sessionId, trackName };
}

export function requireDescription(description: RTCSessionDescriptionInit): CloudflareSFUSessionDescription {
  if ((description.type !== "offer" && description.type !== "answer") || !description.sdp) {
    throw new CloudflareSFUError("Browser SDP description is incomplete", "media_failed");
  }
  return { type: description.type, sdp: description.sdp };
}

export function requireSFUDescription(description: CloudflareSFUSessionDescription | undefined): CloudflareSFUSessionDescription {
  if (!description) throw new CloudflareSFUError("Cloudflare did not return an SDP answer", "signaling_failed");
  return description;
}

export function validatePublicationSnapshot(snapshot: CloudflareSFUPublicationSnapshot): PublicationCursor {
  if (!Number.isSafeInteger(snapshot.incarnation) || snapshot.incarnation < 0 || !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 0) {
    throw new CloudflareSFUError("Cloudflare SFU publication cursor is invalid", "invalid_publication");
  }
  const seen = new Set<string>();
  for (const publication of snapshot.publications) {
    if (!publication.participantSessionId.trim() || !publication.publicationId.trim()) {
      throw new CloudflareSFUError("Cloudflare SFU publication is incomplete", "invalid_publication");
    }
    const key = publicationKey(publication);
    if (seen.has(key)) throw new CloudflareSFUError("Cloudflare SFU publication snapshot contains duplicate participant sources", "invalid_publication");
    seen.add(key);
    parseCloudflareSFUPublicationID(publication.publicationId);
  }
  return { incarnation: snapshot.incarnation, sequence: snapshot.sequence, signature: publicationSignature(snapshot.publications) };
}

export function comparePublicationCursor(current: PublicationCursor | null, next: PublicationCursor): "newer" | "same" | "stale" {
  if (!current || next.incarnation > current.incarnation || (next.incarnation === current.incarnation && next.sequence > current.sequence)) return "newer";
  if (next.incarnation < current.incarnation || next.sequence < current.sequence) return "stale";
  if (next.signature !== current.signature) throw new CloudflareSFUError("Cloudflare SFU returned conflicting data for one publication cursor", "invalid_publication");
  return "same";
}

export function publicationKey(publication: { readonly participantSessionId: string; readonly source: V3MediaSource }): string {
  return `${publication.participantSessionId}\u0000${publication.source}`;
}

function publicationSignature(publications: readonly CloudflareSFUPublication[]): string {
  return [...publications]
    .sort((left, right) => publicationKey(left).localeCompare(publicationKey(right)))
    .map((publication) => `${publicationKey(publication)}\u0000${publication.publicationId}`)
    .join("\u0001");
}

export async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new CloudflareSFUError("Timed out waiting for a remote media track", "media_failed");
    await new Promise((resolve) => globalThis.setTimeout(resolve, 20));
  }
}
