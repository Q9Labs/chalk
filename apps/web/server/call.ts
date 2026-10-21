import { Schema } from "effect";
import { EpisodeIdSchema, SpaceIdSchema, RecordingIdSchema, TranscriptIdSchema, type ListSpacePublicAdmissionRequestsResponse } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { attendance, live, run } from "./engine";
import { callDTO, episodeDTO, recordingDTO, transcriptDTO } from "./dto";
import { homeMutation } from "./home";
import { DashboardError } from "./http";
import { knockDecisionAction, knockDecisionState, type CallAction, type CallPageDTO, type CallStatusDTO, type CallMetadataQuery, type CallMetadataDTO } from "../src/lib/dashboard/contracts";
function mapKnocks(requests: ListSpacePublicAdmissionRequestsResponse["requests"]): CallPageDTO["knocks"] {
  return requests.filter((k) => k.state === "pending" && Date.parse(k.expires_at) > Date.now()).map((k) => ({ handle: k.request_handle, name: k.display_name, requestedAt: k.requested_at, expiresAt: k.expires_at, state: k.state, decisionState: knockDecisionState.parse(k.decision_state), decisionAction: knockDecisionAction.parse(k.decision_action ?? null) }));
}
export async function callMetadata(engine: Engine, input: CallMetadataQuery): Promise<CallMetadataDTO> {
  if (input.kind === "recording") {
    const recording = await run(engine.api.recordings.getRecording({ params: { tenant_id: engine.tenantId, recording_id: Schema.decodeUnknownSync(RecordingIdSchema)(input.id) } }));
    if (recording.space_id !== input.spaceId) throw new DashboardError(404, "recording_not_found");
    const transcripts = await run(engine.api.transcripts.listTranscripts({ params: { tenant_id: engine.tenantId }, query: { recording_id: recording.id, page_size: 5 } }));
    return { kind: "recording", recording: { ...recordingDTO(recording), transcripts: transcripts.transcripts.map(transcriptDTO), transcriptsNextCursor: transcripts.pagination.next_cursor } };
  }
  const transcript = await run(engine.api.transcripts.getTranscript({ params: { tenant_id: engine.tenantId, transcript_id: Schema.decodeUnknownSync(TranscriptIdSchema)(input.id) } }));
  if (transcript.space_id !== input.spaceId) throw new DashboardError(404, "transcript_not_found");
  return { kind: "transcript", transcript: transcriptDTO(transcript) };
}
export async function callStatus(engine: Engine, spaceId: string): Promise<CallStatusDTO> {
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(spaceId) };
  const [episodes, knocks] = await Promise.all([run(engine.api.episodes.listEpisodes({ params, query: { page_size: 1 } })), run(engine.api.spaces.listSpacePublicAdmissionRequests({ params, query: { state: "pending" } }))]);
  const latest = episodes.episodes[0];
  return { latestEpisodeId: latest?.id ?? null, episode: latest && latest.status !== "ended" ? { id: latest.id, status: latest.status } : null, knocks: mapKnocks(knocks.requests) };
}
export async function callPage(engine: Engine, spaceId: string, cursor?: string): Promise<CallPageDTO> {
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(spaceId) };
  const space = await run(engine.api.spaces.getSpace({ params }));
  const [invite, episodes, knocks, current] = await Promise.all([
    run(engine.api.spaces.getSpacePublicInvite({ params })),
    run(engine.api.episodes.listEpisodes({ params, query: { page_size: 5, cursor } })),
    run(engine.api.spaces.listSpacePublicAdmissionRequests({ params, query: { state: "pending" } })),
    live(engine, [spaceId]),
  ]);
  return {
    call: callDTO(space),
    inviteUrl: invite.canonical_url,
    live: current[0]?.episode ?? null,
    episodes: await Promise.all(
      episodes.episodes.map(async (episode) => {
        const [people, recordings] = await Promise.all([attendance(engine, { ...params, episode_id: episode.id }), run(engine.api.recordings.listRecordings({ params: { tenant_id: engine.tenantId }, query: { space_id: params.space_id, episode_id: episode.id, page_size: 5 } }))]);
        return {
          ...episodeDTO(episode),
          participantCount: people.participants.length,
          recordings: await Promise.all(
            recordings.recordings.map(async (recording) => {
              const transcripts = await run(engine.api.transcripts.listTranscripts({ params: { tenant_id: engine.tenantId }, query: { recording_id: recording.id, page_size: 5 } }));
              return { ...recordingDTO(recording), transcripts: transcripts.transcripts.map(transcriptDTO), transcriptsNextCursor: transcripts.pagination.next_cursor };
            }),
          ),
          recordingsNextCursor: recordings.pagination.next_cursor,
        };
      }),
    ),
    nextCursor: episodes.pagination.next_cursor,
    knocks: mapKnocks(knocks.requests),
  };
}
export async function callMutation(engine: Engine, action: Exclude<CallAction, { action: "join" | "refresh-access" }>) {
  if (action.action === "rename-call" || action.action === "set-admission") return homeMutation(engine, action);
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(action.spaceId) };
  await run(engine.api.spaces.getSpace({ params }));
  const headers = { "Idempotency-Key": action.idempotencyKey };
  switch (action.action) {
    case "rotate-link":
      return { inviteUrl: (await run(engine.api.spaces.rotateSpacePublicInvite({ params, headers }))).canonical_url };
    case "end-for-everyone": {
      await run(engine.api.episodes.endEpisode({ params: { ...params, episode_id: Schema.decodeUnknownSync(EpisodeIdSchema)(action.episodeId) }, headers }));
      return { ok: true };
    }
    case "approve-knock":
      await run(engine.api.spaces.approveSpacePublicAdmissionRequest({ params: { ...params, request_handle: action.requestHandle }, headers }));
      return { ok: true };
    case "deny-knock":
      await run(engine.api.spaces.denySpacePublicAdmissionRequest({ params: { ...params, request_handle: action.requestHandle }, headers }));
      return { ok: true };
  }
}
