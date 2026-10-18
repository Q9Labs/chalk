import { Schema } from "effect";
import { EpisodeIdSchema, SpaceIdSchema } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { run } from "./engine";
import { callDTO, episodeDTO } from "./dto";
import { homeMutation } from "./home";
import type { CallAction, CallPageDTO } from "../src/lib/dashboard/contracts";
export async function callPage(engine: Engine, spaceId: string, cursor?: string): Promise<CallPageDTO> {
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(spaceId) };
  const [space, invite, episodes, knocks] = await Promise.all([
    run(engine.api.spaces.getSpace({ params })),
    run(engine.api.spaces.getSpacePublicInvite({ params })),
    run(engine.api.episodes.listEpisodes({ params, query: { page_size: 30, cursor } })),
    run(engine.api.spaces.listSpacePublicAdmissionRequests({ params, query: {} })),
  ]);
  return {
    call: callDTO(space),
    inviteUrl: invite.canonical_url,
    episodes: episodes.episodes.map(episodeDTO),
    nextCursor: episodes.pagination.next_cursor,
    knocks: knocks.requests.map((k) => ({ handle: k.request_handle, name: k.display_name, requestedAt: k.requested_at, expiresAt: k.expires_at, state: k.state })),
  };
}
export async function callMutation(engine: Engine, action: Exclude<CallAction, { action: "join" | "refresh-access" }>) {
  if (action.action === "rename-call" || action.action === "set-admission") return homeMutation(engine, action);
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(action.spaceId) };
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
