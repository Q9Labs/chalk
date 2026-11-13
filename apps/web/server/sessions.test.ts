import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Schema } from "effect";
import { createChalkEffectClient, TenantIdSchema } from "@q9labsai/chalk-client/effect";
import { handleDashboard } from "./application";
import type { Engine } from "./engine";
import type { IdentityProvider } from "./identity";
import { PAGE_ROWS } from "../src/lib/dashboard/contracts";
import { CALL_CAP, recordingsPage, sessionsPage } from "./sessions";
import type { SessionListDTO } from "../src/lib/dashboard/contracts";

afterEach(() => vi.restoreAllMocks());

const tenantId = "11111111-1111-4111-8111-111111111111";
const uuid = (kind: number, n: number) => `${kind.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const SPACE = 0xa,
  EPISODE = 0xb,
  RECORDING = 0xc,
  TRANSCRIPT = 0xd;
const NOW = Date.parse("2026-11-10T12:00:00Z");
const hours = (ago: number) => new Date(NOW - ago * 3_600_000).toISOString();

type Fixture = { spaces: unknown[]; episodes: Map<string, unknown[]>; recordings: unknown[]; transcripts: unknown[]; attendance?: number };
const space = (n: number, name: string) => ({
  id: uuid(SPACE, n),
  tenant_id: tenantId,
  name,
  slug: `call-${n}`,
  archived: false,
  created_at: hours(24 * 90),
  updated_at: hours(24 * 90),
  created_by_user_id: null,
  metadata: {},
  roles: [],
  admission_policy: { mode: "open" },
  default_episode_duration_seconds: 3600,
  maximum_episode_duration_seconds: 86400,
  linger_window_seconds: 60,
  media_plane: "cloudflare_sfu",
  media_plane_setting: null,
  effective_media_plane: null,
  recording_policy: "off",
  recurring_policy: null,
  transcript_language: null,
  transcription_policy: "off",
});
const episode = (n: number, spaceN: number, agoStart: number, minutes = 30, status = "ended") => ({
  id: uuid(EPISODE, n),
  tenant_id: tenantId,
  space_id: uuid(SPACE, spaceN),
  status,
  metadata: {},
  config_snapshot: {},
  deadline_at: hours(agoStart - 1),
  deadline_generation: 1,
  created_at: hours(agoStart),
  started_at: hours(agoStart),
  updated_at: hours(agoStart),
  ...(status === "ended" ? { ended_at: new Date(NOW - agoStart * 3_600_000 + minutes * 60_000).toISOString() } : {}),
});
const recording = (n: number, episodeN: number, spaceN: number, agoStart: number, extra: { source?: string; exportStatus?: string; retryable?: boolean; status?: string } = {}) => ({
  id: uuid(RECORDING, n),
  tenant_id: tenantId,
  space_id: uuid(SPACE, spaceN),
  episode_id: uuid(EPISODE, episodeN),
  status: extra.status ?? "completed",
  metadata: {},
  storage_key: null,
  storage_provider: "r2",
  transcription_policy: "off",
  created_at: hours(agoStart),
  updated_at: hours(agoStart),
  source: { status: extra.source ?? "available" },
  export: { status: extra.exportStatus ?? "ready", retryable: extra.retryable ?? false },
  transcription_preparation: { status: "ready" },
});
const transcript = (n: number, recordingN: number, episodeN: number, spaceN: number, status: string, agoStart: number) => ({
  id: uuid(TRANSCRIPT, n),
  tenant_id: tenantId,
  space_id: uuid(SPACE, spaceN),
  episode_id: uuid(EPISODE, episodeN),
  recording_id: uuid(RECORDING, recordingN),
  status,
  generation: 1,
  languages: ["en"],
  transcript_language: "en",
  created_at: hours(agoStart),
  updated_at: hours(agoStart),
});

/** A fake engine behind the real SDK client: it pages like the API does (newest first, a cursor that is an offset). */
async function engineFor(fixture: Fixture) {
  const reads: string[] = [];
  const page = (items: unknown[], url: URL, key: string) => {
    const size = Number(url.searchParams.get("page_size") ?? 25);
    const start = Number(url.searchParams.get("cursor") ?? 0);
    const slice = items.slice(start, start + size);
    const next = start + size < items.length ? String(start + size) : null;
    return Response.json({ [key]: slice, pagination: { has_more: next !== null, next_cursor: next, page_size: size } });
  };
  const api = await Effect.runPromise(
    createChalkEffectClient({
      baseUrl: "https://engine.example.test",
      fetch: async (input, init) => {
        const request = new Request(input, init);
        const url = new URL(request.url);
        reads.push(`${url.pathname.replace(`/v1/tenants/${tenantId}`, "")}${url.search}`);
        const path = url.pathname.replace(`/v1/tenants/${tenantId}`, "");
        if (path === "/spaces") return page(fixture.spaces, url, "spaces");
        if (path === "/space-activity") {
          const ids = new Set((url.searchParams.get("space_ids") ?? "").split(","));
          return Response.json({
            spaces: fixture.spaces
              .filter((item) => ids.has(String((item as { id: string }).id)))
              .map((item) => {
                const id = String((item as { id: string }).id);
                const first = (fixture.episodes.get(id) ?? [])[0] as { id: string; started_at: string; ended_at?: string; status: string } | undefined;
                return { space_id: id, archived: false, live_episode: null, recent_participants: [], latest_episode: first ? { episode_id: first.id, started_at: first.started_at, ended_at: first.ended_at ?? null, status: first.status } : null };
              }),
          });
        }
        const episodes = /^\/spaces\/([^/]+)\/episodes$/.exec(path);
        if (episodes) return page(fixture.episodes.get(episodes[1] ?? "") ?? [], url, "episodes");
        if (path === "/recordings") {
          const only = url.searchParams.get("space_id");
          return page(only ? fixture.recordings.filter((item) => (item as { space_id: string }).space_id === only) : fixture.recordings, url, "recordings");
        }
        if (path === "/transcripts") return page(fixture.transcripts, url, "transcripts");
        if (path.endsWith("/attendance"))
          return Response.json({
            episode_id: uuid(EPISODE, 1),
            participants: Array.from({ length: fixture.attendance ?? 3 }, (_, index) => ({ participant_id: uuid(0xe, index), display_name: `P${index}`, external_id: null, identity_kind: "user", first_joined_at: hours(5), last_left_at: null, left_reason: null })),
          });
        return Response.json({ error: { code: "route.not_found", message: path } }, { status: 404 });
      },
    }),
  );
  const engine: Engine = { api, tenantId: Schema.decodeUnknownSync(TenantIdSchema)(tenantId), dashboardOrigin: "https://dashboard.example.test", mcpUrl: "https://engine.example.test/mcp" };
  return { engine, reads };
}

function fixtureOf(spaces: { n: number; name: string; episodes: ReturnType<typeof episode>[] }[], recordings: unknown[] = [], transcripts: unknown[] = []): Fixture {
  return { spaces: spaces.map((item) => space(item.n, item.name)), episodes: new Map(spaces.map((item) => [uuid(SPACE, item.n), item.episodes])), recordings, transcripts };
}

describe("past sessions across calls", () => {
  it("lists ended sessions newest first with what each kept, and counts them over the whole range", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { engine } = await engineFor(
      fixtureOf(
        [
          { n: 1, name: "Q9 team", episodes: [episode(1, 1, 2), episode(2, 1, 50, 60), episode(3, 1, 80)] },
          { n: 2, name: "Design review", episodes: [episode(4, 2, 5), episode(5, 2, 1, 30, "active")] },
        ],
        [recording(1, 1, 1, 2), recording(2, 4, 2, 5, { exportStatus: "failed", retryable: true }), recording(3, 4, 2, 6, { exportStatus: "none" })],
        [transcript(1, 1, 1, 1, "completed", 2), transcript(2, 1, 1, 1, "deleted", 2), transcript(3, 2, 4, 2, "transcribing", 5)],
      ),
    );
    const list = await sessionsPage(engine, { from: hours(24 * 30) });
    expect(list.rows.map((row) => [row.callName, row.recording?.video ?? null, row.transcript, row.participantCount])).toEqual([
      ["Q9 team", "play", "ready", 3],
      ["Design review", "retryable", "processing", 3],
      ["Q9 team", null, "none", 3],
      ["Q9 team", null, "none", 3],
    ]);
    expect(list.rows[0]?.transcriptIds).toEqual([uuid(TRANSCRIPT, 1)]);
    expect(list.totals).toEqual({ sessions: 4, seconds: 30 * 60 * 3 + 60 * 60, recorded: 2, transcripts: 1, video: { ready: 1, processing: 0, prepare: 0, failed: 1, expired: 0 } });
    expect(list.calls.map((call) => call.name)).toEqual(["Q9 team", "Design review"]);
    expect(list.nextCursor).toBeNull();
    expect(list.truncated).toBe(false);
  });

  it("applies the date range, the call name and the show filter before it pages", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { engine, reads } = await engineFor(
      fixtureOf(
        [
          { n: 1, name: "Q9 team", episodes: [episode(1, 1, 2), episode(2, 1, 24 * 10)] },
          { n: 2, name: "Design review", episodes: [episode(3, 2, 3)] },
          { n: 3, name: "Old call", episodes: [episode(4, 3, 24 * 40)] },
        ],
        [recording(1, 1, 1, 2)],
      ),
    );
    const week = await sessionsPage(engine, { from: hours(24 * 7), to: hours(0) });
    expect(week.rows.map((row) => row.episode.id)).toEqual([uuid(EPISODE, 1), uuid(EPISODE, 3)]);
    // The call whose latest session is before the range is never read.
    expect(reads.some((read) => read.includes(uuid(SPACE, 3)) && read.includes("/episodes"))).toBe(false);
    expect((await sessionsPage(engine, { from: hours(24 * 7), q: "design" })).rows.map((row) => row.callName)).toEqual(["Design review"]);
    expect((await sessionsPage(engine, { from: hours(24 * 7), show: "recording" })).rows.map((row) => row.episode.id)).toEqual([uuid(EPISODE, 1)]);
    expect((await sessionsPage(engine, { from: hours(24 * 7), show: "none" })).rows.map((row) => row.episode.id)).toEqual([uuid(EPISODE, 3)]);
    expect((await sessionsPage(engine, { from: hours(24 * 7), spaceId: uuid(SPACE, 2) })).rows).toHaveLength(1);
    expect((await sessionsPage(engine, { from: hours(24 * 7), to: hours(48) })).rows).toEqual([]);
  });

  it("pages with a cursor that never repeats or skips a session, and every page reports the same totals", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const episodes = Array.from({ length: 23 }, (_, index) => episode(index + 1, 1, index + 1));
    const { engine } = await engineFor(fixtureOf([{ n: 1, name: "Q9 team", episodes }]));
    const seen: string[] = [];
    const sizes: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    const counts = new Set<number>();
    do {
      const page: SessionListDTO = await sessionsPage(engine, { from: hours(24 * 30), cursor });
      seen.push(...page.rows.map((row) => row.episode.id));
      sizes.push(page.rows.length);
      counts.add(page.totals.sessions);
      cursor = page.nextCursor ?? undefined;
      pages++;
    } while (cursor && pages < 10);
    expect(sizes).toEqual([PAGE_ROWS, PAGE_ROWS, 3]);
    expect(new Set(seen).size).toBe(23);
    expect(seen).toEqual(episodes.map((item) => item.id));
    expect([...counts]).toEqual([23]);
  });

  it("refuses a cursor it did not make", async () => {
    const { engine } = await engineFor(fixtureOf([]));
    await expect(sessionsPage(engine, { cursor: "not-a-cursor" })).rejects.toMatchObject({ status: 400 });
  });

  it("reads at most CALL_CAP calls and says the answer is truncated", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const calls = Array.from({ length: CALL_CAP + 5 }, (_, index) => ({ n: index + 1, name: `Call ${index + 1}`, episodes: [episode(index + 1, index + 1, index + 1)] }));
    const { engine, reads } = await engineFor(fixtureOf(calls));
    const list = await sessionsPage(engine, { from: hours(24 * 30) });
    expect(list.truncated).toBe(true);
    expect(reads.filter((read) => /\/spaces\/[^/]+\/episodes\?/.test(read))).toHaveLength(CALL_CAP);
    // The calls read are the most recently active ones.
    expect(list.totals.sessions).toBe(CALL_CAP);
  });
});

describe("recordings across calls", () => {
  it("lists only sessions that have a recording and filters by the state of the video", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { engine } = await engineFor(
      fixtureOf(
        [{ n: 1, name: "Q9 team", episodes: [episode(1, 1, 1), episode(2, 1, 2), episode(3, 1, 3), episode(4, 1, 4), episode(5, 1, 5)] }],
        [recording(1, 1, 1, 1), recording(2, 2, 1, 2, { exportStatus: "none" }), recording(3, 3, 1, 3, { source: "failed", exportStatus: "none" }), recording(4, 4, 1, 4, { source: "pending", exportStatus: "none", status: "processing" })],
      ),
    );
    const all = await recordingsPage(engine, { from: hours(24 * 30) });
    expect(all.rows.map((row) => row.recording?.video)).toEqual(["play", "preparable", "capture_failed", "capturing"]);
    expect(all.totals.video).toEqual({ ready: 1, prepare: 1, failed: 1, processing: 1, expired: 0 });
    expect((await recordingsPage(engine, { from: hours(24 * 30), status: "failed" })).rows.map((row) => row.episode.id)).toEqual([uuid(EPISODE, 3)]);
    expect((await recordingsPage(engine, { from: hours(24 * 30), status: "processing" })).totals.recorded).toBe(1);
  });
});

describe("the dashboard routes", () => {
  const bindings = {
    CHALK_ENVIRONMENT: "test",
    CHALK_API_ORIGIN: "https://engine.example.test",
    DASHBOARD_ORIGIN: "https://dashboard.example.test",
    GOOGLE_CLIENT_ID: "google",
    GOOGLE_CLIENT_SECRET: "secret",
    APPLE_SERVICES_ID: "apple",
    APPLE_TEAM_ID: "team",
    APPLE_KEY_ID: "key",
    APPLE_PRIVATE_KEY: "key",
    SESSION_SECRET: "a-session-secret-with-at-least-32-characters",
    DASHBOARD_SERVICE_TOKEN: "service",
    DASHBOARD_IDENTITY_PROVIDER: "fixture",
  } as const;
  const provider: IdentityProvider = {
    start: () => Promise.reject(new Error("unused")),
    exchange: () => Promise.reject(new Error("unused")),
    authenticate: () => Promise.resolve({ kind: "unauthenticated" }),
  };

  it.each(["/dashboard-api/sessions", "/dashboard-api/recordings"])("%s needs a signed-in session", async (path) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const response = await handleDashboard(new Request(`https://dashboard.example.test${path}`), bindings, () => provider);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "sign_in_required" } });
  });
});
