import { Schema } from "effect";
import { EpisodeIdSchema, SpaceIdSchema } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { attendance, live, run } from "./engine";
import { callDTO, episodeDTO, recordingDTO, transcriptDTO } from "./dto";
import { homeMutation } from "./home";
import type { CallAction, CallPageDTO } from "../src/lib/dashboard/contracts";
export async function callPage(engine: Engine, spaceId: string, cursor?: string): Promise<CallPageDTO> {
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(spaceId) };
  const space = await run(engine.api.spaces.getSpace({ params }));
  const [invite, episodes, knocks, current] = await Promise.all([
    run(engine.api.spaces.getSpacePublicInvite({ params })),
    run(engine.api.episodes.listEpisodes({ params, query: { page_size: 5, cursor } })),
    run(engine.api.spaces.listSpacePublicAdmissionRequests({ params, query: {} })),
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
    knocks: knocks.requests.map((k) => ({ handle: k.request_handle, name: k.display_name, requestedAt: k.requested_at, expiresAt: k.expires_at, state: k.state })),
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
