import { Schema } from "effect";
import { SpaceIdSchema } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { attendance, live, run } from "./engine";
import { callDTO } from "./dto";
import type { HomeAction, HomeDTO, HomeMetadataDTO } from "../src/lib/dashboard/contracts";
export async function homePage(engine: Engine, cursor?: string): Promise<HomeDTO> {
  const result = await run(engine.api.spaces.listSpaces({ params: { tenant_id: engine.tenantId }, query: { page_size: 5, cursor, archived: false } }));
  return {
    calls: await Promise.all(
      result.spaces.map(async (space) => {
        const metadata = await homeCallMetadata(engine, space.id);
        // Invite reads mint tokens and consume the engine write budget. Fetch only on share/join.
        return { ...callDTO(space), inviteUrl: null, ...metadata };
      }),
    ),
    live: await live(
      engine,
      result.spaces.map((s) => s.id),
    ),
    nextCursor: result.pagination.next_cursor,
  };
}
// At most two tenant reads per Space. The route accepts at most five Spaces.
export async function homeMetadata(engine: Engine, spaceIds: readonly string[]): Promise<HomeMetadataDTO> {
  return { calls: await Promise.all(spaceIds.map((id) => homeCallMetadata(engine, id))) };
}
async function homeCallMetadata(engine: Engine, id: string): Promise<HomeMetadataDTO["calls"][number]> {
  const params = { tenant_id: engine.tenantId, space_id: Schema.decodeUnknownSync(SpaceIdSchema)(id) };
  const episodes = await run(engine.api.episodes.listEpisodes({ params, query: { page_size: 1 } }));
  const latest = episodes.episodes[0];
  const people = latest ? await attendance(engine, { ...params, episode_id: latest.id }) : null;
  return {
    id,
    lastActiveAt: latest ? (latest.ended_at ?? latest.started_at) : null,
    recentPeople: people
      ? people.participants
          .slice()
          .sort((a, b) => b.firstJoinedAt.localeCompare(a.firstJoinedAt))
          .slice(0, 5)
          .map(({ id, name }) => ({ id, name }))
      : [],
  };
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
