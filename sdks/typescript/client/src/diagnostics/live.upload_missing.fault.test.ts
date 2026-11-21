// Fault scenario for the symptom live.upload_missing (observability/registry/areas/report.json), hop (a) of its chain.
// The live request was delivered and acked, the upload issued, and the presigned PUT was aborted by the browser:
// `report.upload` records error(report.network) under the live request's target and no object is stored; in the healthy
// control the lifecycle completes and the op records ok. The scenario drives the real kernel, outbox and
// `createLiveIntrospection`; the frames are compared with the committed hand-off files. CHALK_CHAIN_WRITE=1 rewrites them.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { symptom } from "../../../../../observability/rules/live.upload_missing.mjs";
import type { ParsedAccessGrant } from "../access/grant";
import type { LedgerFrame } from "../telemetry/types";
import { chainTelemetry, handOff } from "./chain.test.helpers";
import { createLiveIntrospection } from "./live";
import { uploadDiagnosticBundle, type IssuedDiagnosticUpload } from "./upload";

const CHAIN = new URL("../../../../../observability/fixtures/live.upload_missing/chain/", import.meta.url);
const framesFile = (run: "positive" | "healthy") => new URL(`client-frames.live.upload_missing.${run}.json`, CHAIN);
const chainFile = (run: "positive" | "healthy") => ({ read: () => readFileSync(framesFile(run), "utf8"), write: process.env.CHALK_CHAIN_WRITE === "1" ? (text: string) => writeFileSync(framesFile(run), text) : undefined });
const liveRequestId = "00000000-0000-4000-8000-000000000112";
const reportId = "00000000-0000-4000-8000-000000000114";
const reportUpload: IssuedDiagnosticUpload = { upload_id: "00000000-0000-4000-8000-000000000115", url: "https://r2.test/diagnostics/tenant/episode/report.json.gz?signature=z", headers: {}, expires_at: "2026-11-21T12:00:00Z" };
const access = {
  subject: { tenantId: "00000000-0000-4000-8000-000000000107", episodeId: "1f8fad5b-d9cb-469f-a165-70867728950e", participantId: "00000000-0000-4000-8000-000000000108" },
  media: { token: "media-token" },
} as unknown as ParsedAccessGrant;
const issued: IssuedDiagnosticUpload = { upload_id: "00000000-0000-4000-8000-000000000113", url: "https://r2.test/diagnostics/tenant/episode/upload.json.gz?signature=x", headers: {}, expires_at: "2026-11-21T12:00:00Z" };

async function drive(run: "positive" | "healthy"): Promise<readonly LedgerFrame[]> {
  const test = chainTelemetry();
  try {
    await test.sync();
    // The seat is the telemetry credential's, stamped at intake: V1SyncClient emits only the request id.
    test.outbox.obs.fact("live_request.received", { live_request_id: liveRequestId });
    if (run === "positive") {
      // A stored report's upload completed beside the live one's aborted PUT.
      const reportAnswers = [() => Response.json(reportUpload), () => new Response(null, { status: 200 }), () => Response.json({ stored: true })];
      let reportIndex = 0;
      const reportFetch: typeof globalThis.fetch = async () => reportAnswers[reportIndex++]();
      await uploadDiagnosticBundle({
        apiBaseURL: "https://api.test",
        tenantId: access.subject.tenantId,
        credential: access.media.token,
        request: { trigger: "report", reportId },
        bundle: async () => new Uint8Array([0x1f, 0x8b, 4]),
        obs: test.outbox.obs,
        fetch: reportFetch,
        sha256: async () => "cd".repeat(32),
        isHidden: () => false,
      }).catch(() => undefined);
    }
    const answers = run === "positive" ? [() => Response.json(issued), () => Promise.reject(new TypeError("offline"))] : [() => Response.json(issued), () => new Response(null, { status: 200 }), () => Response.json({ stored: true })];
    let index = 0;
    const fetch: typeof globalThis.fetch = async () => {
      const answer = answers[index++];
      if (!answer) throw new TypeError(`unexpected fetch ${index}`);
      return answer();
    };
    createLiveIntrospection({
      apiBaseURL: "https://api.test",
      access,
      telemetry: test.outbox,
      connection: () => ({ phase: "live" }),
      fetch,
      isHidden: () => false,
    })({ requestId: liveRequestId, expiresAtMs: WALL_ORIGIN + 60_000 });
    test.advance(1_000);
    // The handler runs the upload lifecycle off the caller's stack; flush until its op has posted.
    await vi.waitFor(async () => {
      await test.outbox.flush();
      expect(test.frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.upload")).length).toBe(run === "positive" ? 2 : 1);
    });
    await test.outbox.dispose();
    return test.frames;
  } finally {
    test.restore();
  }
}

const WALL_ORIGIN = 1_795_599_000_000;

describe(symptom, () => {
  it("positive: the issued live upload's PUT dies on the network and records error(report.network)", async () => {
    const frames = await drive("positive");
    const upload = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.upload"));
    expect(upload).toEqual([
      expect.objectContaining({ kind: "op", outcome: "ok", upload_trigger: "report", report_id: reportId, diagnostic_upload_id: reportUpload.upload_id }),
      expect.objectContaining({ kind: "op", outcome: "error", reason_code: "report.network", upload_trigger: "live", live_request_id: liveRequestId, diagnostic_upload_id: issued.upload_id }),
    ]);
    handOff(frames, chainFile("positive"));
  });

  it("healthy: the live upload completes and records ok", async () => {
    const frames = await drive("healthy");
    const upload = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.upload"));
    expect(upload).toEqual([expect.objectContaining({ kind: "op", outcome: "ok", upload_trigger: "live", live_request_id: liveRequestId, diagnostic_upload_id: issued.upload_id, http_status: 200 })]);
    handOff(frames, chainFile("healthy"));
  });
});
