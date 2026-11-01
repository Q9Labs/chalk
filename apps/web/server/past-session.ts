import { Schema } from "effect";
import { EpisodeIdSchema, RecordingIdSchema, SpaceIdSchema, TranscriptIdSchema } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { attendance, listedRecording, recordingTranscripts, run } from "./engine";
import { episodeDTO, recordingDTO, transcriptDTO } from "./dto";
import { DashboardError } from "./http";
import type { DashboardEnvironment } from "./config";
import type { ArtifactURLDTO, CueDTO, PastSessionAction, PastSessionDTO, TranscriptTextQuery } from "../src/lib/dashboard/contracts";
export async function pastSessionPage(engine: Engine, spaceId: string, episodeId: string, cursor?: string, viewerParticipantId: string | null = null): Promise<PastSessionDTO> {
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(spaceId), episode_id: Schema.decodeUnknownSync(EpisodeIdSchema)(episodeId) };
  const episode = await run(engine.api.episodes.getEpisode({ params }));
  const [space, recordings, people] = await Promise.all([
    run(engine.api.spaces.getSpace({ params: { tenant_id: engine.tenantId, space_id: params.space_id } })),
    run(engine.api.recordings.listRecordings({ params: { tenant_id: engine.tenantId }, query: { space_id: params.space_id, episode_id: params.episode_id, page_size: 30, cursor } })),
    attendance(engine, params),
  ]);
  return {
    callName: space.name,
    episode: episodeDTO(episode),
    attendance: { ...people, participants: people.participants.map((participant) => ({ ...participant, isYou: participant.id === viewerParticipantId })) },
    // The page shows the newest completed transcript of any attempt, so it needs each attempt's recent transcripts, as the Call overview does.
    recordings: await Promise.all(recordings.recordings.map((recording) => listedRecording(engine, recording, "past-session"))),
    nextCursor: recordings.pagination.next_cursor,
  };
}
function artifactDTO(value: { url: string; expires_at: string; method: string; signed_headers: Readonly<Record<string, readonly string[]>> }): ArtifactURLDTO {
  return { url: value.url, expiresAt: value.expires_at, method: value.method, headers: value.signed_headers };
}
export async function pastMutation(engine: Engine, action: PastSessionAction) {
  const tenantParams = { tenant_id: engine.tenantId };
  if ("recordingId" in action) {
    const params = { ...tenantParams, recording_id: Schema.decodeUnknownSync(RecordingIdSchema)(action.recordingId) };
    const recording = await run(engine.api.recordings.getRecording({ params }));
    if (recording.space_id !== action.spaceId || recording.episode_id !== action.episodeId) throw new DashboardError(404, "recording_not_found");
    switch (action.action) {
      case "recording-url":
        return artifactDTO(await run(engine.api.recordings.createRecordingDownloadURL({ params, payload: { expires_in_seconds: 300, download: action.download } })));
      case "export-recording": {
        const result = await run(engine.api.recordings.requestRecordingExport({ params, payload: {} }));
        return { recording: recordingDTO(result.recording) };
      }
      case "create-transcript": {
        const result = await run(engine.api.transcripts.requestTranscript({ params, payload: { idempotency_key: action.idempotencyKey, languages: action.languages } }));
        return { transcript: transcriptDTO(result.transcript) };
      }
      case "transcripts": {
        return recordingTranscripts(engine, params.recording_id, action.view);
      }
    }
  }
  const params = { ...tenantParams, transcript_id: Schema.decodeUnknownSync(TranscriptIdSchema)(action.transcriptId) };
  const transcript = await run(engine.api.transcripts.getTranscript({ params }));
  if (transcript.space_id !== action.spaceId || transcript.episode_id !== action.episodeId) throw new DashboardError(404, "transcript_not_found");
  switch (action.action) {
    case "transcript-document": {
      const document = await run(engine.api.transcripts.getTranscriptDocument({ params }));
      return { cues: document.cues.map((cue) => ({ startMs: cue.start_ms, endMs: cue.end_ms, text: cue.text, speaker: cue.identity ? { name: cue.identity.display_name ?? null, participantRef: cue.identity.participant_ref } : null }) satisfies CueDTO) };
    }
    case "delete-transcript":
      await run(engine.api.transcripts.deleteTranscript({ params }));
      return { ok: true };
  }
}

export async function pastTranscriptText(engine: Engine, env: DashboardEnvironment, input: TranscriptTextQuery): Promise<Response> {
  const transcriptId = Schema.decodeUnknownSync(TranscriptIdSchema)(input.transcriptId);
  const transcript = await run(engine.api.transcripts.getTranscript({ params: { tenant_id: engine.tenantId, transcript_id: transcriptId } }));
  if (transcript.space_id !== input.spaceId || transcript.episode_id !== input.episodeId) throw new DashboardError(404, "transcript_not_found");
  const traceId = crypto.randomUUID().replaceAll("-", "");
  const response = await fetch(new URL(`/v1/tenants/${engine.tenantId}/transcripts/${transcriptId}/text`, env.CHALK_API_ORIGIN), {
    headers: { Authorization: `Bearer ${env.DASHBOARD_SERVICE_TOKEN}`, traceparent: `00-${traceId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01` },
    redirect: "manual",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    console.warn(JSON.stringify({ event: "dashboard.engine_response_failed", engine_status: response.status, trace_id: traceId }));
    throw new DashboardError(response.status === 404 ? 404 : response.status === 409 ? 409 : 502, "transcript_download_failed");
  }
  const headers = new Headers({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" });
  for (const name of ["Content-Type", "Content-Disposition"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(response.body, { headers });
}
