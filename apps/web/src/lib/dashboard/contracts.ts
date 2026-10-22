import { z } from "zod";
import type { AccessGrant, Recording } from "@q9labsai/chalk-client/effect";

const id = z.uuid();
const name = z.string().trim().min(1).max(120);
const idempotencyKey = z.uuid();
const admission = z.enum(["anyone", "knock"]);
export const knockDecisionState = z.enum(["none", "in_flight", "retryable"]);
export const knockDecisionAction = z.enum(["approve", "deny"]).nullable();
export const pageQuery = z.strictObject({ cursor: z.string().max(1024).optional() });
export const callQuery = z.strictObject({ spaceId: id, cursor: z.string().max(1024).optional() });
export const callStatusQuery = z.strictObject({ spaceId: id });
export const callMetadataQuery = z.discriminatedUnion("kind", [z.strictObject({ kind: z.literal("recording"), spaceId: id, id }), z.strictObject({ kind: z.literal("transcript"), spaceId: id, id })]);
export type CallMetadataQuery = z.infer<typeof callMetadataQuery>;
/** The most rows Home lists. One status check covers them all with one engine read, and 300 ids fit in a GET URL. */
export const HOME_STATUS_ROWS = 300;
const spaceIds = (most: number) =>
  z
    .string()
    .transform((value) => value.split(","))
    .pipe(z.array(id).min(1).max(most));
/** Home's check reads activity for up to 300 calls; the call page's roster check uses the engine's 30-Space live read. */
export const homeStatusQuery = z.union([z.strictObject({ home: z.literal("1"), spaceIds: spaceIds(HOME_STATUS_ROWS).default([]) }), z.strictObject({ home: z.undefined().optional(), spaceIds: spaceIds(30) })]);
export type HomeStatusQuery = z.infer<typeof homeStatusQuery>;
export const pastQuery = z.strictObject({ spaceId: id, episodeId: id, cursor: z.string().max(1024).optional() });
export const developerQuery = z.strictObject({ keyCursor: z.string().max(1024).optional(), webhookCursor: z.string().max(1024).optional() });
export const homeAction = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("create-call"), name: name.optional(), admission, idempotencyKey }),
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
  z.strictObject({ action: z.literal("create-transcript"), spaceId: id, episodeId: id, recordingId: id, languages: z.array(z.string().trim().min(1).max(32)).min(1).max(16), idempotencyKey }),
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
      return !value.includes("\\") && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash && ((url.protocol === "https:" && /^https:\/\/[^/?#\s]+$/.test(value)) || (url.protocol === "http:" && url.hostname === "localhost" && /^http:\/\/localhost:[0-9]+$/.test(value)));
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
  z.strictObject({ action: z.literal("update-webhook"), webhookId: id, name: webhookFields.name.optional(), url: webhookFields.url.optional(), enabled: webhookFields.enabled.optional(), eventTypes: webhookFields.eventTypes.optional(), revision: z.number().int().positive(), idempotencyKey }),
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
export type CallDTO = { id: string; name: string; archived: boolean; admission: "anyone" | "knock"; createdAt: string; slug: string };
export type LiveDTO = { spaceId: string; episode: null | { id: string; count: number; participants: { id: string; name: string }[] } };
export type EpisodeDTO = { id: string; status: "active" | "ending" | "ended"; startedAt: string; endedAt: string | null };
export type RecordingDTO = {
  id: string;
  status: Recording["status"];
  sourceStatus: Recording["source"]["status"];
  exportStatus: Recording["export"]["status"];
  exportRetryable: boolean;
  failureMessage: string | null;
  transcriptionStatus: Recording["transcription_preparation"]["status"];
  createdAt: string;
  transcripts?: TranscriptDTO[];
  transcriptsNextCursor?: string | null;
};
export type TranscriptDTO = { id: string; status: string; languages: readonly string[]; createdAt: string };
export type KeyDTO = { id: string; name: string; prefix: string; scopes: readonly string[]; expiresAt: string; revokedAt: string | null; lastUsedAt: string | null };
export type WebhookDTO = { id: string; name: string; url: string; enabled: boolean; revision: number; eventTypes: readonly string[]; lastDelivery?: DeliveryDTO | null };
export type AttendanceDTO = { kind: "available"; participants: { id: string; name: string; kind: "user" | "agent" | "guest"; externalId: string | null; isYou: boolean; firstJoinedAt: string; lastLeftAt: string | null }[] };
export type HomeCallDTO = CallDTO & { inviteUrl: string | null; lastActiveAt: string | null; recentPeople: { id: string; name: string }[] };
export type CueDTO = { startMs: number; endMs: number; text: string; speaker: { name: string | null; participantRef: string } | null };
export type DeliveryDTO = { id: string; state: string; createdAt: string; eventType: string; attempts: number; status: number | null };
export type HomeDTO = { calls: HomeCallDTO[]; live: LiveDTO[]; nextCursor: string | null };
export type CallPageDTO = {
  call: CallDTO;
  inviteUrl: string;
  episodes: (EpisodeDTO & { participantCount: number; recordings: RecordingDTO[]; recordingsNextCursor: string | null })[];
  live: LiveDTO["episode"];
  nextCursor: string | null;
  knocks: { handle: string; name: string; requestedAt: string; expiresAt: string; state: string; decisionState: z.infer<typeof knockDecisionState>; decisionAction: z.infer<typeof knockDecisionAction> }[];
};
export type PastSessionDTO = { episode: EpisodeDTO; attendance: AttendanceDTO; recordings: RecordingDTO[]; nextCursor: string | null };
export type AllowedWebsitesDTO = { allowedWebsites: readonly string[] };
export type DeveloperDTO = AllowedWebsitesDTO & { keys: KeyDTO[]; webhooks: WebhookDTO[]; nextKeyCursor: string | null; nextWebhookCursor: string | null };
export type SecretDTO = { id: string; secret: string };
export type ArtifactURLDTO = { url: string; expiresAt: string; method: string; headers: Readonly<Record<string, readonly string[]>> };
export type DashboardErrorDTO = { error: { code: string; retryable?: true; retryAfterSeconds?: number } };

export type OwnerAccessDTO = { access: AccessGrant };

export type CallStatusDTO = { latestEpisodeId: string | null; episode: Pick<EpisodeDTO, "id" | "status"> | null; knocks: CallPageDTO["knocks"] };
/** `first` is the first page, sent when a call Home doesn't list is among the five newest. */
export type HomeStatusDTO = { live: LiveDTO[]; calls: Pick<HomeCallDTO, "id" | "archived" | "lastActiveAt" | "recentPeople">[]; first?: HomeDTO };

export type CallMetadataDTO = { kind: "recording"; recording: RecordingDTO & Required<Pick<RecordingDTO, "transcripts" | "transcriptsNextCursor">> } | { kind: "transcript"; transcript: TranscriptDTO };
