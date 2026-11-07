import { describe, expect, it } from "vitest";

import { createChalkServerClient } from "./client.js";

describe("ChalkServerClient recordings", () => {
  it("maps recording list, get, export request, and download inputs to the canonical REST contract", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const responses = [
      { recordings: [], pagination: { has_more: false, next_cursor: null, page_size: 25 } },
      recording,
      { export: recording.export, recording },
      {
        expires_at: "2026-09-06T21:00:00Z",
        method: "GET",
        signed_at: "2026-09-06T20:00:00Z",
        signed_headers: {},
        url: "https://download.chalk.test/recording",
      },
    ];
    const client = createChalkServerClient({
      apiKey: "server-secret",
      tenantId: "tenant/one",
      apiBaseURL: "https://api.chalk.test/base",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json(responses[requests.length - 1], {
          status: requests.length === 3 ? 202 : 200,
        });
      },
    });

    await client.recordings.list({
      cursor: "next page",
      episodeId: "episode/one",
      pageSize: 25,
      spaceId: "space/one",
    });
    await client.recordings.get("recording/one");
    await client.recordings.requestExport("recording/one");
    await client.recordings.createDownloadURL("recording/one", {
      download: true,
      expiresInSeconds: 300,
    });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.chalk.test/base/v1/tenants/tenant%2Fone/recordings?cursor=next+page&episode_id=episode%2Fone&page_size=25&space_id=space%2Fone",
      "https://api.chalk.test/base/v1/tenants/tenant%2Fone/recordings/recording%2Fone",
      "https://api.chalk.test/base/v1/tenants/tenant%2Fone/recordings/recording%2Fone/export",
      "https://api.chalk.test/base/v1/tenants/tenant%2Fone/recordings/recording%2Fone/download-url",
    ]);
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "GET", "POST", "POST"]);
    expect(requests[2]?.init?.body).toBe(JSON.stringify({}));
    expect(requests[3]?.init?.body).toBe(JSON.stringify({ expires_in_seconds: 300, download: true }));
  });
});

describe("ChalkServerClient Space Artifact policies", () => {
  it("sends explicit policy choices when creating or updating a Space", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const client = createChalkServerClient({
      apiKey: "server-secret",
      tenantId: "tenant-one",
      apiBaseURL: "https://api.chalk.test",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json({}, { status: requests.length === 1 ? 201 : 200 });
      },
    });

    await client.spaces.create({
      defaultEpisodeDurationSeconds: 86_400,
      lingerWindowSeconds: 0,
      maximumEpisodeDurationSeconds: 86_400,
      mediaPlane: "cf_sfu",
      name: "Design Lab",
      recordingPolicy: "manual",
      slug: "design-lab",
      transcriptionPolicy: "automatic",
    });
    await client.spaces.update("space/one", {
      recordingPolicy: "automatic",
      transcriptionPolicy: "on_demand",
    });

    expect(requests.map(({ url }) => url)).toEqual(["https://api.chalk.test/v1/tenants/tenant-one/spaces", "https://api.chalk.test/v1/tenants/tenant-one/spaces/space%2Fone"]);
    expect(requests.map(({ init }) => init?.method)).toEqual(["POST", "PATCH"]);
    expect(requests.map(({ init }) => JSON.parse(String(init?.body)))).toEqual([
      {
        default_episode_duration_seconds: 86_400,
        linger_window_seconds: 0,
        maximum_episode_duration_seconds: 86_400,
        media_plane: "cf_sfu",
        name: "Design Lab",
        recording_policy: "manual",
        slug: "design-lab",
        transcription_policy: "automatic",
      },
      { recording_policy: "automatic", transcription_policy: "on_demand" },
    ]);
  });
});

const recording = {
  created_at: "2026-09-06T19:00:00Z",
  episode_id: "episode-one",
  export: { retryable: false, status: "ready" },
  id: "recording-one",
  metadata: {},
  source: { status: "available" },
  space_id: "space-one",
  status: "completed",
  storage_key: "recordings/recording-one.webm",
  storage_provider: "r2",
  tenant_id: "tenant-one",
  updated_at: "2026-09-06T20:00:00Z",
};

describe("ChalkServerClient media providers", () => {
  it("declares the own SFU and passes an own-SFU grant through", async () => {
    const jwt = (audience: string) => `${btoa("header")}.${btoa(JSON.stringify({ aud: audience }))}.signature`;
    const requests: Array<RequestInit | undefined> = [];
    const grant = {
      subject: { tenant_id: "tenant-1", space_id: "space-1", episode_id: "episode-1", participant_id: "participant-1", participant_generation: 2 },
      sync: { token: jwt("chalk-sync"), expires_at: "2026-11-05T12:05:00Z" },
      media: {
        token: jwt("chalk-media"),
        expires_at: "2026-11-05T12:05:00Z",
        provider: "chalk_sfu",
        client_payload: { connectionId: "own-1", provider: "chalk_sfu", episodeRef: "ref-1", iceServers: [], capabilities: { serverLayerAdaptation: false, iceRestart: false } },
      },
    };
    const client = createChalkServerClient({
      apiKey: "server-secret",
      tenantId: "tenant-1",
      apiBaseURL: "https://api.chalk.test",
      fetch: async (_input, init) => {
        requests.push(init);
        return Response.json(requests.length === 1 ? { id: "episode-1" } : grant, { status: 201 });
      },
    });

    await client.episodes.create("space-1", {}, { idempotencyKey: "create-episode-0001" });
    const access = await client.participants.issueAccess("space-1", "episode-1", "participant-1", { participantGeneration: 2, replaceMediaConnection: true });

    for (const init of requests) expect(new Headers(init?.headers).get("x-chalk-media-providers")).toBe("cloudflare_sfu,chalk_sfu");
    expect(JSON.parse(JSON.stringify(access)).media).toMatchObject({ provider: "chalk_sfu", client_payload: { connectionId: "own-1", episodeRef: "ref-1", iceServers: [] } });
  });
});
