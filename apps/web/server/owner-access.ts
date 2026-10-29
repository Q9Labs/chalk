import { Effect, Schema } from "effect";
import { EpisodeIdSchema, ParticipantIdSchema, SpaceIdSchema, type Episode } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { live, run } from "./engine";
import { episodeDeadlineCeiling } from "./call";
import type { DashboardEnvironment } from "./config";
import type { Identity } from "./identity";
import { seal } from "./cookies";
import { readOwnerSeat, writeOwnerSeat, type OwnerSeat } from "./owner-seats";
import { DashboardError, json } from "./http";
import type { CallAction, OwnerAccessDTO } from "../src/lib/dashboard/contracts";

// Domain-separated, Tenant/owner/Episode-bound retry identity. A deliberate new
// join uses a new idempotency key and therefore gets a new seat.
async function ownerParticipantId(tenantId: string, userId: string, spaceId: string, episodeId: string, idempotencyKey: string) {
  // RFC 9562 UUIDv5 in the URL namespace; Sync accepts UUID versions 1–5.
  const namespace = Uint8Array.from([0x6b, 0xa7, 0xb8, 0x11, 0x9d, 0xad, 0x11, 0xd1, 0x80, 0xb4, 0x00, 0xc0, 0x4f, 0xd4, 0x30, 0xc8]);
  const name = new TextEncoder().encode(JSON.stringify(["dashboard-owner-seat-v1", tenantId, userId, spaceId, episodeId, idempotencyKey]));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", new Uint8Array([...namespace, ...name])));
  const bytes = new DataView(digest.buffer);
  bytes.setUint8(6, (bytes.getUint8(6) & 0x0f) | 0x50);
  bytes.setUint8(8, (bytes.getUint8(8) & 0x3f) | 0x80);
  const hex = Array.from(digest.slice(0, 16), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return Schema.decodeUnknownSync(ParticipantIdSchema)(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`);
}
export async function ownerAccess(request: Request, env: DashboardEnvironment, engine: Engine, person: Identity, action: Extract<CallAction, { action: "join" | "refresh-access" }>): Promise<Response> {
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(action.spaceId) };
  if (action.action === "refresh-access") {
    const seat = await readOwnerSeat(request, env, person, action);
    const grantParams = { ...params, episode_id: Schema.decodeUnknownSync(EpisodeIdSchema)(seat.episodeId), participant_id: Schema.decodeUnknownSync(ParticipantIdSchema)(seat.participantId) };
    const access = await run(
      engine.api.default
        .issueAccessGrant({
          params: grantParams,
          payload: { participant_generation: seat.generation, replace_media_connection: action.currentMediaToken === undefined, current_media_token: action.currentMediaToken },
        })
        .pipe(
          Effect.catchTag("ParticipantConnectionSupersededError", () =>
            engine.api.default.issueAccessGrant({
              params: grantParams,
              payload: { participant_generation: seat.generation, replace_media_connection: true },
            }),
          ),
        ),
    );
    const episode = await run(engine.api.episodes.getEpisode({ params: { ...params, episode_id: grantParams.episode_id } }));
    return ownerResponse(request, env, person, seat, access, episode);
  }
  await run(engine.api.spaces.prepareSpaceEntrance({ params }));
  const current = (await live(engine, [action.spaceId]))[0]?.episode;
  let episodeId = current?.id;
  if (!episodeId) {
    try {
      episodeId = (await run(engine.api.episodes.createEpisode({ params, headers: { "Idempotency-Key": action.idempotencyKey }, payload: {} }))).id;
    } catch (error) {
      if (!(error instanceof DashboardError) || error.status !== 409) throw error;
      episodeId = (await live(engine, [action.spaceId]))[0]?.episode?.id;
      if (!episodeId) throw error;
    }
  }
  const result = await run(
    engine.api.episodes.admitEpisodeParticipant({
      params: { ...params, episode_id: Schema.decodeUnknownSync(EpisodeIdSchema)(episodeId) },
      headers: { "Idempotency-Key": action.idempotencyKey },
      payload: { admission: "direct", participant_id: await ownerParticipantId(engine.tenantId, person.userId, action.spaceId, episodeId, action.idempotencyKey), role: "owner", name: person.name || person.email },
    }),
  );
  if (!result.access) throw new DashboardError(409, "admission_pending");
  const episode = await run(engine.api.episodes.getEpisode({ params: { ...params, episode_id: Schema.decodeUnknownSync(EpisodeIdSchema)(episodeId) } }));
  return ownerResponse(request, env, person, { userId: person.userId, sessionId: person.sessionId, spaceId: action.spaceId, episodeId, participantId: result.participant.id, generation: result.participant.generation, joinKey: action.idempotencyKey }, result.access, episode);
}
async function ownerResponse(request: Request, env: DashboardEnvironment, person: Identity, binding: Omit<OwnerSeat, "expiresAt">, access: OwnerAccessDTO["access"], episode: Episode): Promise<Response> {
  const seat = { ...binding, expiresAt: Math.min(person.expiresAt, Date.parse(access.media.expires_at), Date.parse(access.sync.expires_at), episode.deadline_at ? Date.parse(episode.deadline_at) : Infinity) };
  const response = json({ access, ownerSeat: await seal(seat, env.SESSION_SECRET, "owner-seat"), deadlineCeiling: episodeDeadlineCeiling(episode) } satisfies OwnerAccessDTO);
  await writeOwnerSeat(request, response, env, person, seat);
  return response;
}
