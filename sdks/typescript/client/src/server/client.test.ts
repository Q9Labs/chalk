import { describe, expect, it } from "vitest";

import { createChalkServerClient } from "./client.js";

describe("ChalkServerClient recordings", () => {
  it("maps recording list, get, and download inputs to the canonical REST contract", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const responses = [{ recordings: [], pagination: { has_more: false, next_cursor: null, page_size: 25 } }, recording, { expires_at: "2026-09-06T21:00:00Z", method: "GET", signed_at: "2026-09-06T20:00:00Z", signed_headers: {}, url: "https://download.chalk.test/recording" }];
    const client = createChalkServerClient({
      apiKey: "server-secret",
      tenantId: "tenant/one",
      apiBaseURL: "https://api.chalk.test/base",
      fetch: async (input, init) => {
        requests.push({ url: String(input), init });
        return Response.json(responses[requests.length - 1], { status: 200 });
      },
    });

    await client.recordings.list({ cursor: "next page", episodeId: "episode/one", pageSize: 25 });
    await client.recordings.get("recording/one");
    await client.recordings.createDownloadURL("recording/one", { expiresInSeconds: 900 });

    expect(requests.map(({ url }) => url)).toEqual([
      "https://api.chalk.test/base/v1/tenants/tenant%2Fone/recordings?cursor=next+page&episode_id=episode%2Fone&page_size=25",
      "https://api.chalk.test/base/v1/tenants/tenant%2Fone/recordings/recording%2Fone",
      "https://api.chalk.test/base/v1/tenants/tenant%2Fone/recordings/recording%2Fone/download-url",
    ]);
    expect(requests.map(({ init }) => init?.method)).toEqual(["GET", "GET", "POST"]);
    expect(requests[2]?.init?.body).toBe(JSON.stringify({ expires_in_seconds: 900 }));
  });
});

const recording = {
  created_at: "2026-09-06T19:00:00Z",
  episode_id: "episode-one",
  id: "recording-one",
  metadata: {},
  space_id: "space-one",
  status: "completed",
  storage_key: "recordings/recording-one.webm",
  storage_provider: "r2",
  tenant_id: "tenant-one",
  updated_at: "2026-09-06T20:00:00Z",
};
