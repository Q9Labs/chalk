import { describe, expect, it } from "vitest";
import { RecorderControlApiClient } from "../src/control-api.js";
import { ControlApiError } from "../src/errors.js";
import { HmacWorkloadSigner } from "../src/workload-auth.js";

const signer = new HmacWorkloadSigner({ secret: "test-secret", environment: "test", releaseId: "release", audience: "control" });
const context = { journeyId: "11111111-1111-4111-8111-111111111111" };

function client(fetch: typeof globalThis.fetch) {
  return new RecorderControlApiClient({ baseUrl: "https://control.test", signer, fetch });
}

describe("control API errors", () => {
  it("names the route and status of a failed response", async () => {
    const control = client((async () => new Response("unavailable", { status: 503 })) as typeof fetch);
    const failure = control.claim({ limit: 1, context });
    await expect(failure).rejects.toBeInstanceOf(ControlApiError);
    await expect(failure).rejects.toThrow("control API request failed: POST /internal/v1/transcription/jobs/claim returned 503");
  });

  it("names the route and network cause of a failed fetch", async () => {
    const cause = Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" });
    const control = client((async () => {
      throw new TypeError("fetch failed", { cause });
    }) as typeof fetch);
    const failure = control.claimCleanup({ limit: 1, context });
    await expect(failure).rejects.toBeInstanceOf(TypeError);
    await expect(failure).rejects.toThrow("fetch failed: POST /internal/v1/transcription/cleanup/claim (ECONNREFUSED)");
  });
});
