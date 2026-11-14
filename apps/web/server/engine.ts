import { Effect, Schema } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { createChalkEffectClient, MEDIA_PROVIDERS, MEDIA_PROVIDERS_HEADER, TenantIdSchema, type Recording } from "@q9labsai/chalk-client/effect";
import { z } from "zod";
import { SITE_ORIGIN } from "../src/lib/site-origin";
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
      // The dashboard ships the current browser SDK, which runs both media providers.
      headers: { [MEDIA_PROVIDERS_HEADER]: MEDIA_PROVIDERS },
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
export async function resolveTenant(env: DashboardEnvironment, person: Identity, provision = false) {
  const api = await client(env);
  const externalId = `${person.provider}:${env.CHALK_ENVIRONMENT}:${person.userId}`;
  const tenant = await run(api.tenants.findTenantByExternalID({ query: { external_id: externalId } }).pipe(Effect.catchTag("TenantNotFoundError", () => Effect.succeed(null))));
  if (tenant) return tenant.id;
  if (!provision) throw new DashboardError(409, "account_not_provisioned");
  return (await run(api.tenants.createTenant({ payload: { name: person.name || "Personal", external_id: externalId, cors_allowed_origins: [...new Set([SITE_ORIGIN, env.DASHBOARD_ORIGIN])] } }))).id;
}
export type Engine = { api: Awaited<ReturnType<typeof client>>; tenantId: Awaited<ReturnType<typeof resolveTenant>>; dashboardOrigin: string; /** Where AI apps connect to this environment's MCP server. */ mcpUrl: string };
const tenantSession = z.object({ scope: z.string(), tenantId: z.uuid(), expiresAt: z.number() });
/** Cache only engine-derived authority, sealed and bound to the authenticated session and engine environment. */
export async function withSessionEngine(request: Request, env: DashboardEnvironment, person: Identity, respond: (engine: Engine) => Promise<Response>): Promise<Response> {
  const scope = JSON.stringify([env.CHALK_API_ORIGIN, env.CHALK_ENVIRONMENT, person.provider, person.userId, person.sessionId]);
  const value = readCookie(request, env, "tenant");
  const cached = value ? tenantSession.parse(await unseal(value, env.SESSION_SECRET, "tenant")) : null;
  const hit = cached !== null && cached.scope === scope && cached.expiresAt > Date.now();
  const tenantId = hit ? Schema.decodeUnknownSync(TenantIdSchema)(cached.tenantId) : await resolveTenant(env, person);
  const response = await respond({ api: await client(env), tenantId, dashboardOrigin: env.DASHBOARD_ORIGIN, mcpUrl: new URL("/mcp", env.CHALK_API_ORIGIN).href });
  if (!hit) writeCookie(response, env, "tenant", await seal({ scope, tenantId, expiresAt: person.expiresAt }, env.SESSION_SECRET, "tenant"), Math.max(0, Math.floor((person.expiresAt - Date.now()) / 1000)));
  return response;
}
const apiFailure = z.object({ error: z.object({ code: z.string().max(100) }) });
const inactiveParticipantFailure = z.object({ error: z.object({ code: z.literal("participant.not_active") }) });
const invalidAPIKeyExpiryFailure = z.object({ error: z.object({ code: z.literal("api_key.invalid_expiry") }) });
async function failureBody(httpError: HttpClientError.HttpClientError, status: number): Promise<unknown> {
  if (httpError.response?.status !== status) return null;
  return Effect.runPromise(httpError.response.json.pipe(Effect.catch(() => Effect.succeed(null))));
}

/** The wire code of an engine failure, and whether the engine really named it, as opposed to us falling back to "engine.unavailable". */
async function engineCode(error: unknown, httpError: HttpClientError.HttpClientError | undefined): Promise<{ readonly code: string; readonly named: boolean }> {
  const decoded = apiFailure.safeParse(error);
  if (decoded.success) return { code: decoded.data.error.code, named: true };
  // New wire codes can arrive through the SDK's existing transport error channel
  // without widening the tagged error union in a 5.x release.
  if (httpError) {
    if (inactiveParticipantFailure.safeParse(await failureBody(httpError, 409)).success) return { code: "participant.not_active", named: true };
    if (invalidAPIKeyExpiryFailure.safeParse(await failureBody(httpError, 400)).success) return { code: "api_key.invalid_expiry", named: true };
  }
  return { code: "engine.unavailable", named: false };
}

const CONFLICT_CODES = ["conflict", "already_active", "already_exists", "capacity_exceeded"];

function dashboardErrorFor(code: string, status: number | undefined): DashboardError {
  if (status === 429) return new DashboardError(429, "engine_rate_limited");
  if (code === "api_key.invalid_expiry") return new DashboardError(400, "api_key_invalid_expiry");
  if (code === "request.invalid") return new DashboardError(400, "invalid_request");
  if (code.endsWith("not_found") || code === "access.forbidden") return new DashboardError(404, "resource_not_found");
  if (code === "participant.connection_superseded" || code === "media_token.subject_mismatch" || CONFLICT_CODES.some((part) => code.includes(part))) return new DashboardError(409, "engine_conflict");
  if (code.includes("rate_limited")) return new DashboardError(429, "engine_rate_limited");
  if (code === "participant.not_active") return new DashboardError(409, "participant_not_active");
  return new DashboardError(502, "engine_unavailable");
}

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
  const { code, named } = await engineCode(result.error, httpError);
  // Generated API errors decode a fixed contract code. Never log their message,
  // the response, or the request (which contains the service bearer).
  console.warn(
    JSON.stringify({
      event: "dashboard.engine_failed",
      engine_status: httpError?.response?.status,
      engine_code: named ? code : undefined,
      sdk_error_tag: httpError ? httpError._tag : Schema.isSchemaError(result.error) ? result.error._tag : undefined,
      sdk_error_reason: httpError?.reason._tag,
    }),
  );
  throw dashboardErrorFor(code, httpError?.response?.status);
}
type LiveEpisodeRow = { episode_id: string; participant_count: number; participants: readonly { participant_id: string; display_name: string }[] } | null;
export function liveDTO(spaceId: string, liveEpisode: LiveEpisodeRow): LiveDTO {
  return { spaceId, episode: liveEpisode && { id: liveEpisode.episode_id, count: liveEpisode.participant_count, participants: liveEpisode.participants.map((p) => ({ id: p.participant_id, name: p.display_name })) } };
}
export async function live(engine: Engine, spaceIds: readonly string[]): Promise<LiveDTO[]> {
  if (!spaceIds.length) return [];
  const result = await run(engine.api.episodes.listSpaceLiveEpisodes({ params: { tenant_id: engine.tenantId }, query: { space_ids: spaceIds.join(",") } }));
  return result.spaces.map((row) => liveDTO(row.space_id, row.live_episode));
}
export async function attendance(engine: Engine, params: Parameters<Engine["api"]["episodes"]["getEpisodeAttendance"]>[0]["params"]): Promise<AttendanceDTO> {
  const result = await run(engine.api.episodes.getEpisodeAttendance({ params }));
  return { kind: "available", participants: result.participants.map((p) => ({ id: p.participant_id, name: p.display_name, kind: p.identity_kind, externalId: p.external_id, firstJoinedAt: p.first_joined_at, isYou: false, lastLeftAt: p.last_left_at })) };
}

/** The most rows the API returns for one page of any list. */
export const ENGINE_MAX_PAGE_SIZE = 100;

/** The call screen shows a recording's few newest transcripts; the past session shows every one the API returns. */
export function transcriptPageSize(view: "call" | "past-session"): number {
  return view === "call" ? 5 : ENGINE_MAX_PAGE_SIZE;
}

/** Each view reads one page of `pageSize` transcripts. */
export async function recordingTranscripts(engine: Engine, recordingId: Recording["id"], pageSize: number) {
  const result = await run(engine.api.transcripts.listTranscripts({ params: { tenant_id: engine.tenantId }, query: { recording_id: recordingId, page_size: pageSize } }));
  return { transcripts: result.transcripts.map(transcriptDTO) };
}

/** A failed list leaves the fresh recording unlisted, so a page retries only that list. */
export async function listedRecording(engine: Engine, recording: Recording, pageSize: number): Promise<RecordingDTO> {
  try {
    const result = await recordingTranscripts(engine, recording.id, pageSize);
    return { ...recordingDTO(recording), transcripts: result.transcripts };
  } catch (error) {
    console.warn(JSON.stringify({ event: "dashboard.transcripts_unlisted", error_type: error instanceof Error ? error.name : typeof error }));
    return recordingDTO(recording);
  }
}
