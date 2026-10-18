import { Schema } from "effect";
import { EpisodeIdSchema, RecordingIdSchema, SpaceIdSchema, TranscriptIdSchema } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { attendance, run } from "./engine";
import { episodeDTO, recordingDTO, transcriptDTO } from "./dto";
import { DashboardError } from "./http";
import type { ArtifactURLDTO, PastSessionAction, PastSessionDTO } from "../src/lib/dashboard/contracts";
export async function pastSessionPage(engine: Engine, spaceId: string, episodeId: string, cursor?: string): Promise<PastSessionDTO> {
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(spaceId), episode_id: Schema.decodeUnknownSync(EpisodeIdSchema)(episodeId) };
  const episode = await run(engine.api.episodes.getEpisode({ params }));
  const [recordings, people] = await Promise.all([run(engine.api.recordings.listRecordings({ params: { tenant_id: engine.tenantId }, query: { space_id: params.space_id, episode_id: params.episode_id, page_size: 30, cursor } })), attendance(engine, params)]);
  return { episode: episodeDTO(episode), attendance: people, recordings: recordings.recordings.map(recordingDTO), nextCursor: recordings.pagination.next_cursor };
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
      case "transcripts": {
        const result = await run(engine.api.transcripts.listTranscripts({ params: tenantParams, query: { recording_id: params.recording_id, page_size: 30, cursor: action.cursor } }));
        return { transcripts: result.transcripts.map(transcriptDTO), nextCursor: result.pagination.next_cursor };
      }
    }
  }
  const params = { ...tenantParams, transcript_id: Schema.decodeUnknownSync(TranscriptIdSchema)(action.transcriptId) };
  const transcript = await run(engine.api.transcripts.getTranscript({ params }));
  if (transcript.space_id !== action.spaceId || transcript.episode_id !== action.episodeId) throw new DashboardError(404, "transcript_not_found");
  switch (action.action) {
    case "transcript-document": {
      const document = await run(engine.api.transcripts.getTranscriptDocument({ params }));
      return { cues: document.cues.map((cue) => ({ startMs: cue.start_ms, endMs: cue.end_ms, text: cue.text })) };
    }
    case "transcript-url":
      return artifactDTO(await run(engine.api.transcripts.createTranscriptDownloadURL({ params, payload: { expires_in_seconds: 300 } })));
    case "delete-transcript":
      await run(engine.api.transcripts.deleteTranscript({ params }));
      return { ok: true };
  }
}
