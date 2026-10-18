import { z } from "zod";
import type { AccessGrant } from "@q9labsai/chalk-client/effect";

const id = z.uuid();
const name = z.string().trim().min(1).max(120);
const idempotencyKey = z.uuid();
const admission = z.enum(["anyone", "knock"]);
export const pageQuery = z.strictObject({ cursor: z.string().max(1024).optional() });
export const callQuery = z.strictObject({ spaceId: id, cursor: z.string().max(1024).optional() });
export const pastQuery = z.strictObject({ spaceId: id, episodeId: id, cursor: z.string().max(1024).optional() });
export const developerQuery = z.strictObject({ keyCursor: z.string().max(1024).optional(), webhookCursor: z.string().max(1024).optional() });
export const homeAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create-call"), name, admission, idempotencyKey }),
  z.strictObject({ action: z.literal("rename-call"), spaceId: id, name }),
  z.strictObject({ action: z.literal("set-admission"), spaceId: id, admission }),
  z.strictObject({ action: z.literal("archive-call"), spaceId: id }),
  z.strictObject({ action: z.literal("restore-call"), spaceId: id }),
]);
export const callAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("join"), spaceId: id, idempotencyKey }),
  z.strictObject({ action: z.literal("refresh-access"), spaceId: id, currentMediaToken: z.string().min(1).max(8192).optional() }),
  z.strictObject({ action: z.literal("rename-call"), spaceId: id, name }),
  z.strictObject({ action: z.literal("set-admission"), spaceId: id, admission }),
  z.strictObject({ action: z.literal("rotate-link"), spaceId: id, idempotencyKey }),
  z.strictObject({ action: z.literal("end-for-everyone"), spaceId: id, episodeId: id, idempotencyKey }),
  z.strictObject({ action: z.literal("approve-knock"), spaceId: id, requestHandle: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), idempotencyKey }),
  z.strictObject({ action: z.literal("deny-knock"), spaceId: id, requestHandle: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/), idempotencyKey }),
]);
export const pastAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("recording-url"), spaceId: id, episodeId: id, recordingId: id, download: z.boolean() }),
  z.strictObject({ action: z.literal("export-recording"), spaceId: id, episodeId: id, recordingId: id, idempotencyKey }),
  z.strictObject({ action: z.literal("transcripts"), spaceId: id, episodeId: id, recordingId: id, cursor: z.string().max(1024).optional() }),
  z.strictObject({ action: z.literal("transcript-document"), spaceId: id, episodeId: id, transcriptId: id }),
  z.strictObject({ action: z.literal("transcript-url"), spaceId: id, episodeId: id, transcriptId: id }),
  z.strictObject({ action: z.literal("delete-transcript"), spaceId: id, episodeId: id, transcriptId: id }),
]);
const scope = z.enum(["spaces:read", "spaces:write", "episodes:read", "episodes:write", "recordings:read", "recordings:write", "transcriptions:read", "transcriptions:write", "webhooks:read", "webhooks:write"]);
const eventType = z.enum([
  "episode.ended",
  "episode.started",
  "participant.joined",
  "participant.left",
  "recording.started",
  "recording.completed",
  "recording.failed",
  "transcript.started",
  "transcript.completed",
  "transcript.failed",
  "space.archived",
  "space.created",
  "space.restored",
  "space.updated",
]);
const webhookFields = { name, url: z.url().refine((value) => new URL(value).protocol === "https:", "HTTPS required"), enabled: z.boolean(), eventTypes: z.array(eventType).min(1).max(14) };
export const dashboardWebsiteOrigin = "https://chalkmeet.com";
const websiteOrigin = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return !url.username && !url.password && ((url.protocol === "https:" && /^https:\/\/[^/?#\s]+$/.test(value)) || (url.protocol === "http:" && url.hostname === "localhost" && /^http:\/\/localhost:[0-9]+$/.test(value)));
    } catch {
      return false;
    }
  }, "Use an HTTPS origin or http://localhost with an explicit port")
  .transform((value) => {
    const url = new URL(value);
    return url.protocol === "http:" ? `http://localhost:${url.port || "80"}` : url.origin;
  });
const allowedWebsites = z
  .array(websiteOrigin)
  .max(32)
  .transform((origins) => [...new Set([dashboardWebsiteOrigin, ...origins])])
  .refine((origins) => origins.length <= 32, "At most 32 origins including chalkmeet.com");
export const developerAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("allowed-websites") }),
  z.strictObject({ action: z.literal("set-allowed-websites"), origins: allowedWebsites }),
  z.strictObject({ action: z.literal("create-key"), name, scopes: z.array(scope).min(1).max(10), expiresAt: z.iso.datetime(), idempotencyKey }),
  z.strictObject({ action: z.literal("rotate-key"), keyId: id, expiresAt: z.iso.datetime(), idempotencyKey }),
  z.strictObject({ action: z.literal("revoke-key"), keyId: id }),
  z.strictObject({ action: z.literal("create-webhook"), ...webhookFields, idempotencyKey }),
  z.strictObject({ action: z.literal("update-webhook"), webhookId: id, ...webhookFields, revision: z.number().int().positive(), idempotencyKey }),
  z.strictObject({ action: z.literal("delete-webhook"), webhookId: id, revision: z.number().int().positive(), idempotencyKey }),
  z.strictObject({ action: z.literal("rotate-webhook-secret"), webhookId: id, revokePreviousImmediately: z.boolean(), idempotencyKey }),
  z.strictObject({ action: z.literal("test-webhook"), webhookId: id, idempotencyKey }),
  z.strictObject({ action: z.literal("webhook-deliveries"), webhookId: id, cursor: z.string().max(1024).optional() }),
  z.strictObject({ action: z.literal("webhook-delivery"), webhookId: id, deliveryId: id }),
  z.strictObject({ action: z.literal("redeliver-webhook"), webhookId: id, deliveryId: id, idempotencyKey }),
]);
export type HomeAction = z.infer<typeof homeAction>;
export type CallAction = z.infer<typeof callAction>;
export type PastSessionAction = z.infer<typeof pastAction>;
export type DeveloperAction = z.infer<typeof developerAction>;
export type ProfileDTO = { name: string; email: string; avatarUrl: string | null };
export type SessionDTO = { profile: ProfileDTO; csrfToken: string };
export type CallDTO = { id: string; name: string; archived: boolean; admission: "anyone" | "knock"; createdAt: string };
export type LiveDTO = { spaceId: string; episode: null | { id: string; count: number; participants: { id: string; name: string }[] } };
export type EpisodeDTO = { id: string; status: "active" | "ending" | "ended"; startedAt: string; endedAt: string | null };
export type RecordingDTO = { id: string; status: string; exportStatus: string; createdAt: string };
export type TranscriptDTO = { id: string; status: string; languages: readonly string[]; createdAt: string };
export type KeyDTO = { id: string; name: string; prefix: string; scopes: readonly string[]; expiresAt: string; revokedAt: string | null };
export type WebhookDTO = { id: string; name: string; url: string; enabled: boolean; revision: number; eventTypes: readonly string[] };
export type AttendanceDTO = { kind: "available"; participants: { id: string; name: string; kind: "user" | "agent" | "guest"; externalId: string | null; intervals: { joinedAt: string; leftAt: string | null }[] }[] } | { kind: "unavailable"; reason: "attendance_api_pending" };
export type HomeDTO = { calls: CallDTO[]; live: LiveDTO[]; nextCursor: string | null };
export type CallPageDTO = { call: CallDTO; inviteUrl: string; episodes: EpisodeDTO[]; nextCursor: string | null; knocks: { handle: string; name: string; requestedAt: string; expiresAt: string; state: string }[] };
export type PastSessionDTO = { episode: EpisodeDTO; attendance: AttendanceDTO; recordings: RecordingDTO[]; nextCursor: string | null };
export type AllowedWebsitesDTO = { allowedWebsites: readonly string[] };
export type DeveloperDTO = AllowedWebsitesDTO & { keys: KeyDTO[]; webhooks: WebhookDTO[]; nextKeyCursor: string | null; nextWebhookCursor: string | null };
export type SecretDTO = { id: string; secret: string };
export type ArtifactURLDTO = { url: string; expiresAt: string; method: string; headers: Readonly<Record<string, readonly string[]>> };
export type DashboardErrorDTO = { error: { code: string } };

export type OwnerAccessDTO = { access: AccessGrant };

export type RefreshRequiredDTO = { error: { code: "refresh_or_sign_in_required" }; csrfToken: string };
