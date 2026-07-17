import { expect, it, vi } from "vitest";
import { __internal, runMonitorCycle, type Env } from "./index";

const atlasURL = "https://atlas.example.test/";
const ingestPath = "/api/v1/ops/ingest/monitor-results";

function environment(): Env {
  return {
    API_BASE_URL: "https://api.example.test",
    OPS_INGEST_TOKEN: "test-ingest-token",
    ATLAS_BASE_URL: atlasURL,
    CHECK_RETRIES: "0",
  };
}

function requestedURL(input: string | URL | Request): URL {
  return new URL(input instanceof Request ? input.url : input);
}

it("accepts only the branded architecture denial boundary", async () => {
  __internal.resetForTests();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  let includeBoundaryHeaders = true;
  const fetchMock = vi.fn(async (input: string | URL | Request) => {
    const url = requestedURL(input);
    if (url.pathname === ingestPath) return new Response("accepted", { status: 202 });
    if (url.origin !== new URL(atlasURL).origin) return new Response("ok");
    const headers = includeBoundaryHeaders
      ? {
          "www-authenticate": 'Chalk-Access-Code realm="Architecture atlas"',
          "x-chalk-atlas-build": "build-id",
        }
      : undefined;
    return new Response("access code required", { status: 401, headers });
  });
  vi.stubGlobal("fetch", fetchMock);

  const healthy = await runMonitorCycle(environment(), new Date("2026-04-14T12:00:30Z"));
  expect(healthy.checked_count).toBe(__internal.DEFAULT_MONITORS.length + 1);
  expect(healthy.failed_count).toBe(0);
  expect(fetchMock).toHaveBeenCalledWith(atlasURL, expect.objectContaining({ method: "GET" }));

  includeBoundaryHeaders = false;
  const failed = await runMonitorCycle(environment(), new Date("2026-04-14T12:00:45Z"));
  expect(failed.failed_count).toBe(1);
});
