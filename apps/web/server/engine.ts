import { Effect } from "effect";
import { createChalkEffectClient } from "@q9labsai/chalk-client/effect";
import { z } from "zod";
import { dashboardWebsiteOrigin } from "../src/lib/dashboard/contracts";
import type { DashboardEnvironment } from "./config";
import type { Identity } from "./identity";
import type { AttendanceDTO, LiveDTO } from "../src/lib/dashboard/contracts";
import { DashboardError } from "./http";

function client(env: DashboardEnvironment) {
  return Effect.runPromise(createChalkEffectClient({ baseUrl: env.CHALK_API_ORIGIN, auth: { type: "bearer", token: env.DASHBOARD_SERVICE_TOKEN }, fetch: (input, init) => fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(15000) }) }));
}
// This is the only Tenant selection point. No request value can supply its authority.
export async function resolveTenant(env: DashboardEnvironment, person: Identity, provision = false) {
  const api = await client(env);
  const externalId = `workos:${env.CHALK_ENVIRONMENT}:${person.userId}`;
  const tenant = await run(api.tenants.findTenantByExternalID({ query: { external_id: externalId } }).pipe(Effect.catchTag("TenantNotFoundError", () => Effect.succeed(null))));
  if (tenant) return tenant.id;
  if (!provision) throw new DashboardError(409, "account_not_provisioned");
  return (await run(api.tenants.createTenant({ payload: { name: person.name || "Personal", external_id: externalId, cors_allowed_origins: [...new Set([dashboardWebsiteOrigin, env.DASHBOARD_ORIGIN])] } }))).id;
}
export async function engine(env: DashboardEnvironment, person: Identity) {
  const tenantId = await resolveTenant(env, person);
  return { api: await client(env), tenantId, dashboardOrigin: env.DASHBOARD_ORIGIN };
}
export type Engine = Awaited<ReturnType<typeof engine>>;
const apiFailure = z.object({ error: z.object({ code: z.string().max(100) }) });
export async function run<A, E>(operation: Effect.Effect<A, E>): Promise<A> {
  const result = await Effect.runPromise(
    operation.pipe(
      Effect.match({
        onSuccess: (value) => ({ kind: "success" as const, value }),
        onFailure: (error) => ({ kind: "failure" as const, error }),
      }),
    ),
  );
  if (result.kind === "success") return result.value;
  const status = z.object({ response: z.object({ status: z.number() }) }).safeParse(result.error);
  if (status.success && status.data.response.status === 429) throw new DashboardError(429, "engine_rate_limited");
  const failure = apiFailure.safeParse(result.error);
  const code = failure.success ? failure.data.error.code : "engine.unavailable";
  if (code.endsWith("not_found") || code === "access.forbidden") throw new DashboardError(404, "resource_not_found");
  if (code.includes("conflict") || code.includes("already_active") || code.includes("already_exists") || code.includes("capacity_exceeded")) throw new DashboardError(409, "engine_conflict");
  if (code.includes("rate_limited")) throw new DashboardError(429, "engine_rate_limited");
  throw new DashboardError(502, "engine_unavailable");
}
export async function live(engine: Engine, spaceIds: readonly string[]): Promise<LiveDTO[]> {
  if (!spaceIds.length) return [];
  const result = await run(engine.api.episodes.listSpaceLiveEpisodes({ params: { tenant_id: engine.tenantId }, query: { space_ids: spaceIds.join(",") } }));
  return result.spaces.map((row) => ({ spaceId: row.space_id, episode: row.live_episode && { id: row.live_episode.episode_id, count: row.live_episode.participant_count, participants: row.live_episode.participants.map((p) => ({ id: p.participant_id, name: p.display_name })) } }));
}
export async function attendance(engine: Engine, params: Parameters<Engine["api"]["episodes"]["getEpisodeAttendance"]>[0]["params"]): Promise<AttendanceDTO> {
  const result = await run(engine.api.episodes.getEpisodeAttendance({ params }));
  return { kind: "available", participants: result.participants.map((p) => ({ id: p.participant_id, name: p.display_name, kind: p.identity_kind, externalId: p.external_id, firstJoinedAt: p.first_joined_at, isYou: false, lastLeftAt: p.last_left_at })) };
}
