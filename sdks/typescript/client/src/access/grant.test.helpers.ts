import type { ParsedAccessGrant } from "./grant";

export const ACCESS_SUBJECT = {
  tenantId: "tenant-1",
  spaceId: "space-1",
  episodeId: "episode-1",
  participantId: "participant-1",
  participantGeneration: 1,
} as const;

export function accessGrant(expiresAt: number, suffix: string, connectionId = "connection-1"): ParsedAccessGrant {
  return {
    subject: ACCESS_SUBJECT,
    sync: { token: credential("chalk-sync", suffix), expiresAt: new Date(expiresAt).toISOString() },
    media: { token: credential("chalk-media", suffix), expiresAt: new Date(expiresAt).toISOString(), provider: "cloudflare_sfu", clientPayload: { connectionId, stunServer: "stun:stun.cloudflare.com:3478" } },
  };
}

function credential(audience: "chalk-sync" | "chalk-media", suffix: string) {
  const encode = (json: string) => btoa(json).replace(/[+/=]/g, (character) => ({ "+": "-", "/": "_", "=": "" })[character] ?? "");
  return `${encode('{"alg":"EdDSA"}')}.${encode(`{"aud":"${audience}"}`)}.${suffix}` as ParsedAccessGrant["sync"]["token"] & ParsedAccessGrant["media"]["token"];
}
