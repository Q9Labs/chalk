import { Effect, Schema } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { createChalkEffectClient, TenantIdSchema, type Recording } from "@q9labsai/chalk-client/effect";
import { z } from "zod";
import { dashboardWebsiteOrigin } from "../src/lib/dashboard/contracts";
import type { DashboardEnvironment } from "./config";
import type { Identity } from "./identity";
import type { AttendanceDTO, LiveDTO, RecordingDTO } from "../src/lib/dashboard/contracts";
import { recordingDTO, transcriptDTO } from "./dto";
import { DashboardError } from "./http";
import { readCookie, seal, unseal, writeCookie } from "./cookies";

function client(env: DashboardEnvironment) {
  return Effect.runPromise(
    createChalkEffectClient({
      baseUrl: env.CHALK_API_ORIGIN,
      auth: { type: "bearer", token: env.DASHBOARD_SERVICE_TOKEN },
      fetch: async (input, init) => {
        const traceId = crypto.randomUUID().replaceAll("-", "");
        const headers = new Headers(init?.headers);
        headers.set("traceparent", `00-${traceId}-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}-01`);
        const response = await fetch(input, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(15000) });
        if (!response.ok) console.warn(JSON.stringify({ event: "dashboard.engine_response_failed", engine_status: response.status, trace_id: traceId }));
        return response;
      },
    }),
  );
}
// This is the only Tenant selection point. No request value can supply its authority.
export async function resolveTenant(env: DashboardEnvironment, person: Identity, provision = false) {
  const api = await client(env);
  const externalId = `${person.provider}:${env.CHALK_ENVIRONMENT}:${person.userId}`;
  const tenant = await run(api.tenants.findTenantByExternalID({ query: { external_id: externalId } }).pipe(Effect.catchTag("TenantNotFoundError", () => Effect.succeed(null))));
  if (tenant) return tenant.id;
  if (!provision) throw new DashboardError(409, "account_not_provisioned");
  return (await run(api.tenants.createTenant({ payload: { name: person.name || "Personal", external_id: externalId, cors_allowed_origins: [...new Set([dashboardWebsiteOrigin, env.DASHBOARD_ORIGIN])] } }))).id;
}
export type Engine = { api: Awaited<ReturnType<typeof client>>; tenantId: Awaited<ReturnType<typeof resolveTenant>>; dashboardOrigin: string };
const tenantSession = z.object({ scope: z.string(), tenantId: z.uuid(), expiresAt: z.number() });
/** Cache only engine-derived authority, sealed and bound to the authenticated session and engine environment. */
export async function withSessionEngine(request: Request, env: DashboardEnvironment, person: Identity, respond: (engine: Engine) => Promise<Response>): Promise<Response> {
  const scope = JSON.stringify([env.CHALK_API_ORIGIN, env.CHALK_ENVIRONMENT, person.provider, person.userId, person.sessionId]);
  const value = readCookie(request, env, "tenant");
  const cached = value ? tenantSession.parse(await unseal(value, env.SESSION_SECRET, "tenant")) : null;
  const hit = cached !== null && cached.scope === scope && cached.expiresAt > Date.now();
  const tenantId = hit ? Schema.decodeUnknownSync(TenantIdSchema)(cached.tenantId) : await resolveTenant(env, person);
  const response = await respond({ api: await client(env), tenantId, dashboardOrigin: env.DASHBOARD_ORIGIN });
  if (!hit) writeCookie(response, env, "tenant", await seal({ scope, tenantId, expiresAt: person.expiresAt }, env.SESSION_SECRET, "tenant"), Math.max(0, Math.floor((person.expiresAt - Date.now()) / 1000)));
  return response;
}
const apiFailure = z.object({ error: z.object({ code: z.string().max(100) }) });
const inactiveParticipantFailure = z.object({ error: z.object({ code: z.literal("participant.not_active") }) });
const invalidAPIKeyExpiryFailure = z.object({ error: z.object({ code: z.literal("api_key.invalid_expiry") }) });
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
  const httpError = HttpClientError.isHttpClientError(result.error) ? result.error : undefined;
  // New wire codes can arrive through the SDK's existing transport error channel
  // without widening the tagged error union in a 5.x release.
  const inactiveParticipant = httpError?.response?.status === 409 && inactiveParticipantFailure.safeParse(await Effect.runPromise(httpError.response.json.pipe(Effect.catch(() => Effect.succeed(null))))).success;
  const invalidAPIKeyExpiry = httpError?.response?.status === 400 && invalidAPIKeyExpiryFailure.safeParse(await Effect.runPromise(httpError.response.json.pipe(Effect.catch(() => Effect.succeed(null))))).success;
  const failure = apiFailure.safeParse(result.error);
  const code = failure.success ? failure.data.error.code : inactiveParticipant ? "participant.not_active" : invalidAPIKeyExpiry ? "api_key.invalid_expiry" : "engine.unavailable";
  // Generated API errors decode a fixed contract code. Never log their message,
  // the response, or the request (which contains the service bearer).
  console.warn(
    JSON.stringify({
      event: "dashboard.engine_failed",
      engine_status: httpError?.response?.status,
      engine_code: failure.success || inactiveParticipant || invalidAPIKeyExpiry ? code : undefined,
      sdk_error_tag: httpError ? httpError._tag : Schema.isSchemaError(result.error) ? result.error._tag : undefined,
      sdk_error_reason: httpError?.reason._tag,
    }),
  );
  if (httpError?.response?.status === 429) throw new DashboardError(429, "engine_rate_limited");
  if (code === "api_key.invalid_expiry") throw new DashboardError(400, "api_key_invalid_expiry");
  if (code === "request.invalid") throw new DashboardError(400, "invalid_request");
  if (code.endsWith("not_found") || code === "access.forbidden") throw new DashboardError(404, "resource_not_found");
  if (code === "participant.connection_superseded" || code.includes("conflict") || code.includes("already_active") || code.includes("already_exists") || code.includes("capacity_exceeded")) throw new DashboardError(409, "engine_conflict");
  if (code.includes("rate_limited")) throw new DashboardError(429, "engine_rate_limited");
  if (code === "participant.not_active") throw new DashboardError(409, "participant_not_active");
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

/** Each view reads one page. The API's real maximum is MaxPageSize = 100 in apps/api/internal/pagination/pagination.go:15. */
export async function recordingTranscripts(engine: Engine, recordingId: Recording["id"], view: "call" | "past-session" = "past-session") {
  const result = await run(engine.api.transcripts.listTranscripts({ params: { tenant_id: engine.tenantId }, query: { recording_id: recordingId, page_size: view === "call" ? 5 : 100 } }));
  return { transcripts: result.transcripts.map(transcriptDTO) };
}

/** A failed list leaves the fresh recording unlisted, so a page retries only that list. */
export async function listedRecording(engine: Engine, recording: Recording, view: "call" | "past-session" = "call"): Promise<RecordingDTO> {
  try {
    const result = await recordingTranscripts(engine, recording.id, view);
    return { ...recordingDTO(recording), transcripts: result.transcripts };
  } catch {
    return recordingDTO(recording);
  }
}
