import { Effect, Schema } from "effect";
import { HttpClientError } from "effect/unstable/http";
import { createChalkEffectClient, TenantIdSchema, type Recording } from "@q9labsai/chalk-client/effect";
import { z } from "zod";
import { dashboardWebsiteOrigin } from "../src/lib/dashboard/contracts";
import type { DashboardEnvironment } from "./config";
import type { Identity } from "./identity";
import type { AttendanceDTO, LiveDTO, RecordingDTO, TranscriptDTO } from "../src/lib/dashboard/contracts";
import { completedTranscript } from "../src/lib/dashboard/recording";
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
  const failure = apiFailure.safeParse(result.error);
  // Generated API errors decode a fixed contract code. Never log their message,
  // the response, or the request (which contains the service bearer).
  console.warn(
    JSON.stringify({
      event: "dashboard.engine_failed",
      engine_status: httpError?.response?.status,
      engine_code: failure.success ? failure.data.error.code : undefined,
      sdk_error_tag: httpError ? httpError._tag : Schema.isSchemaError(result.error) ? result.error._tag : undefined,
      sdk_error_reason: httpError?.reason._tag,
    }),
  );
  if (httpError?.response?.status === 429) throw new DashboardError(429, "engine_rate_limited");
  const code = failure.success ? failure.data.error.code : "engine.unavailable";
  if (code.endsWith("not_found") || code === "access.forbidden") throw new DashboardError(404, "resource_not_found");
  if (code === "participant.connection_superseded" || code.includes("conflict") || code.includes("already_active") || code.includes("already_exists") || code.includes("capacity_exceeded")) throw new DashboardError(409, "engine_conflict");
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

/** Failed and deleted rows must not hide an older completed transcript. Bound each search and retain its continuation. */
export async function recordingTranscripts(engine: Engine, recordingId: Recording["id"], cursor?: string) {
  const transcripts: TranscriptDTO[] = [];
  let nextCursor: string | null = cursor ?? null;
  for (let page = 0; page < 5; page++) {
    const result = await run(engine.api.transcripts.listTranscripts({ params: { tenant_id: engine.tenantId }, query: { recording_id: recordingId, page_size: 5, cursor: nextCursor ?? undefined } }));
    transcripts.push(...result.transcripts.map(transcriptDTO));
    nextCursor = result.pagination.next_cursor;
    if (transcripts.some(completedTranscript) || !nextCursor) break;
  }
  return { transcripts, nextCursor };
}

/** A failed list leaves the fresh recording unlisted, so a page retries only that list. */
export async function listedRecording(engine: Engine, recording: Recording): Promise<RecordingDTO> {
  try {
    const result = await recordingTranscripts(engine, recording.id);
    return { ...recordingDTO(recording), transcripts: result.transcripts, transcriptsNextCursor: result.nextCursor };
  } catch {
    return recordingDTO(recording);
  }
}
