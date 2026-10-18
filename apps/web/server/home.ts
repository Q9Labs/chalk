import { Schema } from "effect";
import { SpaceIdSchema } from "@q9labsai/chalk-client/effect";
import type { Engine } from "./engine";
import { live, run } from "./engine";
import { callDTO } from "./dto";
import type { HomeAction, HomeDTO } from "../src/lib/dashboard/contracts";
export async function homePage(engine: Engine, cursor?: string): Promise<HomeDTO> {
  const result = await run(engine.api.spaces.listSpaces({ params: { tenant_id: engine.tenantId }, query: { page_size: 30, cursor, archived: false } }));
  return {
    calls: result.spaces.map(callDTO),
    live: await live(
      engine,
      result.spaces.map((s) => s.id),
    ),
    nextCursor: result.pagination.next_cursor,
  };
}
export async function homeMutation(engine: Engine, action: HomeAction) {
  const params = { tenant_id: engine.tenantId };
  if (action.action === "create-call") {
    const space = await run(
      engine.api.spaces.createSpace({
        params,
        headers: { "Idempotency-Key": action.idempotencyKey },
        payload: { name: action.name, slug: `call-${action.idempotencyKey}`, admission_policy: { mode: action.admission === "anyone" ? "open" : "knock" }, default_episode_duration_seconds: 3600, maximum_episode_duration_seconds: 86400, linger_window_seconds: 60 },
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
