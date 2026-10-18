import { Effect, Schema } from "effect";
import { createChalkEffectClient, TenantIdSchema } from "@q9labsai/chalk-client/effect";
import { z } from "zod";
import { dashboardWebsiteOrigin } from "../src/lib/dashboard/contracts";
import type { DashboardEnvironment } from "./config";
import type { Identity } from "./identity";
import type { AttendanceDTO, LiveDTO } from "../src/lib/dashboard/contracts";
import { DashboardError } from "./http";

const tenant = z.object({ id: z.uuid() });
const liveResponse = z.object({ spaces: z.array(z.object({ space_id: z.uuid(), live_episode: z.object({ episode_id: z.uuid(), participant_count: z.number().int().nonnegative(), participants: z.array(z.object({ participant_id: z.uuid(), display_name: z.string() })) }).nullable() })) });
const attendanceResponse = z.object({
  episode_id: z.uuid(),
  participants: z.array(z.object({ participant_id: z.uuid(), display_name: z.string(), identity_kind: z.enum(["user", "agent", "guest"]), external_id: z.string().nullable(), intervals: z.array(z.object({ joined_at: z.string(), left_at: z.string().nullable() })) })),
});
async function bridge(env: DashboardEnvironment, path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(new URL(path, env.CHALK_API_ORIGIN).toString(), { ...init, headers: { Authorization: `Bearer ${env.DASHBOARD_SERVICE_TOKEN}`, "Content-Type": "application/json", ...init?.headers }, redirect: "manual", signal: AbortSignal.timeout(15000) });
  return response;
}
// This is the only Tenant selection point. No request value can supply its authority.
export async function resolveTenant(env: DashboardEnvironment, person: Identity, provision = false) {
  const externalId = `workos:${env.CHALK_ENVIRONMENT}:${person.userId}`;
  let response = await bridge(env, `/v1/tenants/by-external-id?external_id=${encodeURIComponent(externalId)}`);
  if (response.status === 404 && provision) {
    response = await bridge(env, "/v1/tenants", { method: "POST", body: JSON.stringify({ name: person.name || "Personal", external_id: externalId, cors_allowed_origins: [...new Set([dashboardWebsiteOrigin, env.DASHBOARD_ORIGIN])] }) });
  }
  if (!response.ok) throw new DashboardError(response.status === 404 ? 409 : 502, response.status === 404 ? "account_not_provisioned" : "engine_unavailable");
  return Schema.decodeUnknownSync(TenantIdSchema)(tenant.parse(await response.json()).id);
}
export async function engine(env: DashboardEnvironment, person: Identity) {
  const tenantId = await resolveTenant(env, person);
  const api = await Effect.runPromise(createChalkEffectClient({ baseUrl: env.CHALK_API_ORIGIN, auth: { type: "bearer", token: env.DASHBOARD_SERVICE_TOKEN }, fetch: (input, init) => fetch(input, { ...init, redirect: "manual", signal: AbortSignal.timeout(15000) }) }));
  return { api, tenantId };
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
  const failure = apiFailure.safeParse(result.error);
  const code = failure.success ? failure.data.error.code : "engine.unavailable";
  if (code.endsWith("not_found") || code === "access.forbidden") throw new DashboardError(404, "resource_not_found");
  if (code.includes("conflict") || code.includes("already_active") || code.includes("capacity_exceeded")) throw new DashboardError(409, "engine_conflict");
  if (code.includes("rate_limited")) throw new DashboardError(429, "engine_rate_limited");
  throw new DashboardError(502, "engine_unavailable");
}
export async function live(env: DashboardEnvironment, tenantId: Engine["tenantId"], spaceIds: string[]): Promise<LiveDTO[]> {
  if (!spaceIds.length) return [];
  const response = await bridge(env, `/v1/tenants/${tenantId}/live-episodes?space_ids=${spaceIds.join(",")}`);
  if (!response.ok) throw new DashboardError(502, "live_read_unavailable");
  return liveResponse
    .parse(await response.json())
    .spaces.map((row) => ({ spaceId: row.space_id, episode: row.live_episode && { id: row.live_episode.episode_id, count: row.live_episode.participant_count, participants: row.live_episode.participants.map((p) => ({ id: p.participant_id, name: p.display_name })) } }));
}
export async function attendance(env: DashboardEnvironment, tenantId: Engine["tenantId"], spaceId: string, episodeId: string): Promise<AttendanceDTO> {
  const response = await bridge(env, `/v1/tenants/${tenantId}/spaces/${spaceId}/episodes/${episodeId}/attendance`);
  if (response.status === 404 || response.status === 501) return { kind: "unavailable", reason: "attendance_api_pending" };
  if (!response.ok) throw new DashboardError(502, "attendance_read_unavailable");
  const result = attendanceResponse.parse(await response.json());
  if (result.episode_id !== episodeId) throw new DashboardError(502, "attendance_mismatch");
  return { kind: "available", participants: result.participants.map((p) => ({ id: p.participant_id, name: p.display_name, kind: p.identity_kind, externalId: p.external_id, intervals: p.intervals.map((i) => ({ joinedAt: i.joined_at, leftAt: i.left_at })) })) };
}
