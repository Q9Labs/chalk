import { Effect, Schema } from "effect";
import { createChalkEffectClient, TenantIdSchema, TranscriptIdSchema } from "@q9labsai/chalk-client/effect";
import { afterEach, expect, it, vi } from "vitest";
import { configuration } from "./config";
import { pastTranscriptText } from "./past-session";
import { handleDashboard } from "./application";

const env = configuration({
  CHALK_ENVIRONMENT: "test",
  CHALK_API_ORIGIN: "https://engine.example.test",
  DASHBOARD_ORIGIN: "https://dashboard.example.test",
  GOOGLE_CLIENT_ID: "fixture",
  GOOGLE_CLIENT_SECRET: "fixture",
  APPLE_SERVICES_ID: "fixture",
  APPLE_TEAM_ID: "fixture",
  APPLE_KEY_ID: "fixture",
  APPLE_PRIVATE_KEY: "fixture",
  SESSION_SECRET: "fixture-session-key-with-at-least-32-characters",
  DASHBOARD_SERVICE_TOKEN: "fixture-service",
  DASHBOARD_IDENTITY_PROVIDER: "fixture",
});
const id = (index: number) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const input = { spaceId: id(1), episodeId: id(2), transcriptId: id(3) };
const transcript = { id: id(3), tenant_id: id(4), space_id: id(1), episode_id: id(2), recording_id: id(5), generation: 1, status: "complete", languages: ["ur"], created_at: "2026-11-01T12:00:00Z", updated_at: "2026-11-01T12:00:00Z" };
const text = "Release planning · 1 Nov 2026 · 42 min\nLanguages: Urdu\n\n[00:00:04] حسن: شکریہ۔\n";
const filename = "attachment; filename=transcript-2026-11-01.txt; filename*=UTF-8''%D8%A7%D8%B1%D8%AF%D9%88-2026-11-01.txt";
async function engine() {
  const api = await Effect.runPromise(createChalkEffectClient({ baseUrl: env.CHALK_API_ORIGIN, auth: { type: "bearer", token: env.DASHBOARD_SERVICE_TOKEN } }));
  return { api, tenantId: Schema.decodeUnknownSync(TenantIdSchema)(id(4)), dashboardOrigin: env.DASHBOARD_ORIGIN };
}
afterEach(() => vi.restoreAllMocks());

it("streams the text attachment and API filename without exposing its service credential", async () => {
  const upstream = new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": filename, "Set-Cookie": "private=secret" } });
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (!String(url).endsWith("/text")) return Response.json(transcript);
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-service");
    return upstream;
  });
  const result = await pastTranscriptText(await engine(), env, input);
  expect(result.body).toBe(upstream.body);
  expect(result.headers.get("Content-Disposition")).toBe(filename);
  expect(result.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
  expect(result.headers.get("Cache-Control")).toBe("private, no-store");
  expect(result.headers.has("Set-Cookie")).toBe(false);
  expect(await result.text()).toBe(text);
  expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([`${env.CHALK_API_ORIGIN}/v1/tenants/${id(4)}/transcripts/${id(3)}`, `${env.CHALK_API_ORIGIN}/v1/tenants/${id(4)}/transcripts/${id(3)}/text`]);
});

it.each([{ spaceId: id(8) }, { episodeId: id(8) }])("does not download a transcript from another Space or Episode: %j", async (foreign) => {
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(transcript));
  await expect(pastTranscriptText(await engine(), env, { ...input, ...foreign })).rejects.toMatchObject({ status: 404 });
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([404, 409, 500])("does not serve an upstream %s error as a text attachment", async (status) => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => (String(url).endsWith("/text") ? new Response("private upstream detail", { status }) : Response.json(transcript)));
  await expect(pastTranscriptText(await engine(), env, input)).rejects.toMatchObject({ status: status === 500 ? 502 : status, code: "transcript_download_failed" });
});

it("requires a dashboard session before downloading text", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  const response = await handleDashboard(new Request(`${env.DASHBOARD_ORIGIN}/dashboard-api/transcript-text?${new URLSearchParams(input)}`), env, () => ({
    start: async () => {
      throw new Error("unused");
    },
    exchange: async () => {
      throw new Error("unused");
    },
    authenticate: async () => ({ kind: "unauthenticated" }),
  }));
  expect(response.status).toBe(401);
  expect(fetcher).not.toHaveBeenCalled();
});

it("the generated client reads the public text route as UTF-8 text, not JSON", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(text, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": filename } }));
  const client = await engine();
  const result = await Effect.runPromise(client.api.transcripts.getTranscriptText({ params: { tenant_id: client.tenantId, transcript_id: Schema.decodeUnknownSync(TranscriptIdSchema)(id(3)) } }));
  expect(result).toBe(text);
});
