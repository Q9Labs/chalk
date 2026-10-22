import { Schema } from "effect";
import { SpaceIdSchema } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { run } from "./engine";
import { callDTO } from "./dto";
import type { HomeAction, HomeDTO, HomeStatusDTO, HomeStatusQuery, LiveDTO } from "../src/lib/dashboard/contracts";
type Activity = { live: LiveDTO; call: HomeStatusDTO["calls"][number] };
/** What a Home row shows for each Space: one tenant read for up to 300 Spaces. */
async function activity(engine: Engine, spaceIds: readonly string[]): Promise<Activity[]> {
  if (!spaceIds.length) return [];
  const result = await run(engine.api.spaces.listSpaceActivity({ params: { tenant_id: engine.tenantId }, query: { space_ids: spaceIds.join(",") } }));
  return result.spaces.map((row) => ({
    live: { spaceId: row.space_id, episode: row.live_episode && { id: row.live_episode.episode_id, count: row.live_episode.participant_count, participants: row.live_episode.participants.map((p) => ({ id: p.participant_id, name: p.display_name })) } },
    call: { id: row.space_id, lastActiveAt: row.latest_episode ? (row.latest_episode.ended_at ?? row.latest_episode.started_at) : null, recentPeople: row.recent_participants.map((p) => ({ id: p.participant_id, name: p.display_name })) },
  }));
}
// Two tenant reads: the page of Spaces, then their activity.
export async function homePage(engine: Engine, cursor?: string): Promise<HomeDTO> {
  const result = await run(engine.api.spaces.listSpaces({ params: { tenant_id: engine.tenantId }, query: { page_size: 5, cursor, archived: false } }));
  const rows = await activity(
    engine,
    result.spaces.map((space) => space.id),
  );
  return {
    // Fetch invite links only on share/join, not for every Home row.
    calls: result.spaces.map((space) => ({ ...callDTO(space), inviteUrl: null, lastActiveAt: null, recentPeople: [], ...rows.find((row) => row.call.id === space.id)?.call })),
    live: rows.map((row) => row.live),
    nextCursor: result.pagination.next_cursor,
  };
}
/**
 * Every listed Space's live state, last active time and recent people in one tenant read. With `home`, one more
 * read lists the newest page, and the answer carries the first page (two more reads) when any call on it isn't
 * listed: a call made in this tab can be newest while one made elsewhere just before it is still missing.
 */
export async function homeStatus(engine: Engine, query: HomeStatusQuery): Promise<HomeStatusDTO> {
  const [rows, newest] = await Promise.all([activity(engine, query.spaceIds), query.home ? run(engine.api.spaces.listSpaces({ params: { tenant_id: engine.tenantId }, query: { page_size: 5, archived: false } })).then((result) => result.spaces.map((space) => space.id)) : []]);
  const status = { live: rows.map((row) => row.live), calls: rows.map((row) => row.call) };
  return newest.some((id) => !query.spaceIds.includes(id)) ? { ...status, first: await homePage(engine) } : status;
}
export async function homeMutation(engine: Engine, action: HomeAction) {
  const params = { tenant_id: engine.tenantId };
  if (action.action === "create-call") {
    const space = await run(
      engine.api.spaces.createSpace({
        params,
        headers: { "Idempotency-Key": action.idempotencyKey },
        payload: { name: action.name ?? "New call", slug: `call-${action.idempotencyKey}`, admission_policy: { mode: action.admission === "anyone" ? "open" : "knock" }, default_episode_duration_seconds: 3600, maximum_episode_duration_seconds: 86400, linger_window_seconds: 60 },
      }),
    );
    return { call: callDTO(space) };
  }
  const spaceParams = { ...params, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(action.spaceId) };
  switch (action.action) {
    case "archive-call":
      return { call: callDTO(await run(engine.api.spaces.archiveSpace({ params: spaceParams }))) };
    case "restore-call":
      return { call: callDTO(await run(engine.api.spaces.restoreSpace({ params: spaceParams }))) };
    case "rename-call":
    case "set-admission": {
      const patch = action.action === "rename-call" ? { name: action.name } : { admission_policy: { mode: action.admission === "anyone" ? "open" : "knock" } };
      const space = await run(engine.api.spaces.updateSpace({ params: spaceParams, payload: patch }));
      return { call: callDTO(space) };
    }
  }
}
