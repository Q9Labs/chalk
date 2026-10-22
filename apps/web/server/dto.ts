import type { APIKeyList, Episode, Recording, Space, Transcript, WebhookEndpoint } from "@q9labsai/chalk-client/effect";
import { z } from "zod";
import type { CallDTO, EpisodeDTO, KeyDTO, RecordingDTO, TranscriptDTO, WebhookDTO } from "../src/lib/dashboard/contracts";
const admissionPolicy = z.object({ mode: z.string() });
export function callDTO(space: Space): CallDTO {
  const policy = admissionPolicy.safeParse(space.admission_policy);
  return { id: space.id, name: space.name, archived: space.archived, admission: policy.success && policy.data.mode === "knock" ? "knock" : "anyone", slug: space.slug, createdAt: space.created_at };
}
export function episodeDTO(episode: Episode): EpisodeDTO {
  return { id: episode.id, status: episode.status, startedAt: episode.started_at, endedAt: episode.ended_at ?? null };
}
export function recordingDTO(recording: Recording): RecordingDTO {
  return {
    id: recording.id,
    status: recording.status,
    sourceStatus: recording.source.status,
    sourceExpiresAt: recording.source.expires_at ?? null,
    exportStatus: recording.export.status,
    exportRetryable: recording.export.retryable,
    failureMessage: recording.export.failure_message ?? null,
    transcriptionStatus: recording.transcription_preparation.status,
    createdAt: recording.created_at,
  };
}
export function transcriptDTO(transcript: Transcript): TranscriptDTO {
  return { id: transcript.id, status: transcript.status, languages: transcript.languages, createdAt: transcript.created_at };
}
export function keyDTO(key: APIKeyList["api_keys"][number]): KeyDTO {
  return { id: key.id, name: key.name, prefix: key.key_prefix, scopes: key.scopes, expiresAt: key.expires_at, revokedAt: key.revoked_at, lastUsedAt: key.last_used_at };
}
export function webhookDTO(webhook: WebhookEndpoint): WebhookDTO {
  return { id: webhook.id, name: webhook.name, url: webhook.url_redacted, enabled: webhook.enabled, revision: webhook.revision, eventTypes: webhook.event_types };
}
