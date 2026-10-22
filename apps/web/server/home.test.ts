import { Effect, Schema } from "effect";
import { createChalkEffectClient, TenantIdSchema } from "@q9labsai/chalk-client/effect";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { homeStatusQuery } from "../src/lib/dashboard/contracts";
import { homePage, homeStatus } from "./home";

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const tenant = uuid(0x7e);
const at = "2026-10-22T10:00:00Z";
const ended = "2026-10-22T10:07:53Z";
const nora = { display_name: "Nora", participant_id: uuid(0xa1) };
const space = (id: string) => ({
  admission_policy: { mode: "knock" },
  archived: false,
  created_at: at,
  created_by_user_id: null,
  default_episode_duration_seconds: 3600,
  id,
  linger_window_seconds: 60,
  maximum_episode_duration_seconds: 86400,
  media_plane: "cloudflare",
  metadata: {},
  name: `Call ${id.slice(-3)}`,
  recording_policy: "off",
  recurring_policy: null,
  roles: [],
  slug: `call-${id}`,
  tenant_id: tenant,
  transcription_policy: "off",
  updated_at: at,
});
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

/**
 * The engine over HTTP, answering through the real SDK decoder: Spaces newest first, and each one's activity. A Space
 * in `live` has that Episode live; every other Space last ended an Episode at `ended`.
 */
async function fakeEngine(spaces: string[], live: Record<string, string>) {
  const requests: URL[] = [];
  const api = await Effect.runPromise(
    createChalkEffectClient({
      baseUrl: "https://engine.example.test",
      fetch: async (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        requests.push(url);
        const path = url.pathname.replace(`/v1/tenants/${tenant}`, "");
        if (path === "/space-activity") {
          const ids = url.searchParams.get("space_ids")?.split(",") ?? [];
          return json({
            spaces: ids.map((id) => {
              const episode = live[id];
              return {
                space_id: id,
                live_episode: episode ? { episode_id: episode, participant_count: 1, participants: [nora] } : null,
                latest_episode: { episode_id: episode ?? uuid(0xe0), status: episode ? "active" : "ended", started_at: at, ended_at: episode ? null : ended },
                recent_participants: [nora],
              };
            }),
          });
        }
        if (path === "/live-episodes") {
          const ids = url.searchParams.get("space_ids")?.split(",") ?? [];
          const roster = Array.from({ length: 7 }, (_, index) => ({ display_name: `Guest ${index}`, participant_id: uuid(0xa00 + index) }));
          return json({ spaces: ids.map((id) => ({ space_id: id, live_episode: live[id] ? { episode_id: live[id], participant_count: roster.length, participants: roster } : null })) });
        }
        if (path === "/spaces") {
          const size = Number(url.searchParams.get("page_size"));
          return json({ spaces: spaces.slice(0, size).map(space), pagination: { has_more: spaces.length > size, next_cursor: spaces.length > size ? String(size) : null, page_size: size } });
        }
        throw new Error(`unexpected ${url.pathname}`);
      },
    }),
  );
  return { engine: { api, tenantId: Schema.decodeUnknownSync(TenantIdSchema)(tenant), dashboardOrigin: "https://dashboard.example.test" }, requests };
}
const spaceIds = (count: number) => Array.from({ length: count }, (_, index) => uuid(0x100 + index));
const paths = (requests: URL[]) => requests.map((url) => url.pathname.split("/").at(-1));

describe("Home", () => {
  it("answers every one of 300 rows with one engine read", async () => {
    const ids = spaceIds(300);
    const { engine, requests } = await fakeEngine(ids, { [ids[299] ?? ""]: uuid(0xe1) });
    const status = await homeStatus(engine, { spaceIds: ids, home: "1" });
    expect(paths(requests).sort()).toEqual(["space-activity", "spaces"]);
    expect(
      requests
        .find((url) => url.pathname.endsWith("/space-activity"))
        ?.searchParams.get("space_ids")
        ?.split(","),
    ).toEqual(ids);
    expect(status.calls).toHaveLength(300);
    expect(status.calls[0]).toEqual({ id: ids[0], lastActiveAt: ended, recentPeople: [{ id: nora.participant_id, name: "Nora" }] });
    expect(status.calls[299]?.lastActiveAt).toBe(at);
    expect(status.live[299]).toEqual({ spaceId: ids[299], episode: { id: uuid(0xe1), count: 1, participants: [{ id: nora.participant_id, name: "Nora" }] } });
    expect(status.first).toBeUndefined();
  });

  it("returns the first page when the newest call isn't listed", async () => {
    const ids = spaceIds(3);
    const { engine } = await fakeEngine([uuid(0x99), ...ids], {});
    const status = await homeStatus(engine, { spaceIds: ids, home: "1" });
    expect(status.first?.calls.map((call) => call.id)).toEqual([uuid(0x99), ...ids]);
    expect(status.first?.calls[0]?.lastActiveAt).toBe(ended);
  });

  it("returns the first page when a call below the newest isn't listed", async () => {
    const ids = spaceIds(3);
    const [mine = "", ...older] = ids;
    const { engine } = await fakeEngine([mine, uuid(0x99), ...older], {});
    const status = await homeStatus(engine, { spaceIds: ids, home: "1" });
    expect(status.first?.calls.map((call) => call.id)).toEqual([mine, uuid(0x99), ...older]);
  });

  it("loads a page of calls with two engine reads", async () => {
    const ids = spaceIds(7);
    const { engine, requests } = await fakeEngine(ids, {});
    const page = await homePage(engine);
    expect(page.calls.map((call) => call.id)).toEqual(ids.slice(0, 5));
    expect(page.calls.every((call) => call.lastActiveAt === ended && call.recentPeople.length === 1)).toBe(true);
    expect(paths(requests)).toEqual(["spaces", "space-activity"]);
  });

  it("answers the call page's roster check with the full live roster in one engine read", async () => {
    const ids = spaceIds(1);
    const { engine, requests } = await fakeEngine(ids, { [ids[0] ?? ""]: uuid(0xe1) });
    const status = await homeStatus(engine, { spaceIds: ids });
    expect(status.live[0]?.episode?.participants).toHaveLength(7);
    expect(status.live[0]?.episode?.count).toBe(7);
    expect(paths(requests)).toEqual(["live-episodes"]);
  });
});

// The dashboard answers a ZodError with its own 400, so an over-long list never reaches the engine as a 502.
describe("home-status query", () => {
  const ids = (count: number) => Array.from({ length: count }, (_, index) => uuid(0x100 + index)).join(",");
  it("lets Home check up to 300 calls", () => {
    expect(homeStatusQuery.parse({ home: "1", spaceIds: ids(300) }).spaceIds).toHaveLength(300);
    expect(() => homeStatusQuery.parse({ home: "1", spaceIds: ids(301) })).toThrow(z.ZodError);
  });
  it("keeps every other caller at the engine's 30-Space live read", () => {
    expect(homeStatusQuery.parse({ spaceIds: ids(30) }).spaceIds).toHaveLength(30);
    expect(() => homeStatusQuery.parse({ spaceIds: ids(31) })).toThrow(z.ZodError);
  });
});
