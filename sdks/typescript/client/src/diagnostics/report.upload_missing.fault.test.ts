// Fault scenario for the symptom report.upload_missing (observability/registry/areas/report.json), hop (a) of its chain.
// The report stored, the upload issued, and the presigned PUT was aborted by the browser: `report.upload` records
// error(report.network) under the issued id and no object is stored; in the healthy control the lifecycle completes and
// the op records ok. The scenario drives the real `uploadDiagnosticBundle` into the real kernel and outbox, and the
// frames are compared with the committed hand-off files. CHALK_CHAIN_WRITE=1 rewrites them.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { symptom } from "../../../../../observability/rules/report.upload_missing.mjs";
import type { LedgerFrame } from "../telemetry/types";
import { chainTelemetry, handOff } from "./chain.test.helpers";
import { uploadDiagnosticBundle, type IssuedDiagnosticUpload } from "./upload";

const CHAIN = new URL("../../../../../observability/fixtures/report.upload_missing/chain/", import.meta.url);
const framesFile = (run: "positive" | "healthy") => new URL(`client-frames.report.upload_missing.${run}.json`, CHAIN);
const chainFile = (run: "positive" | "healthy") => ({ read: () => readFileSync(framesFile(run), "utf8"), write: process.env.CHALK_CHAIN_WRITE === "1" ? (text: string) => writeFileSync(framesFile(run), text) : undefined });
const journey = "00000000-0000-4000-8000-000000000104";
const reportId = "00000000-0000-4000-8000-000000000105";
const liveRequestId = "00000000-0000-4000-8000-000000000108";
const issued: IssuedDiagnosticUpload = { upload_id: "00000000-0000-4000-8000-000000000106", url: "https://r2.test/diagnostics/tenant/episode/upload.json.gz?signature=x", headers: {}, expires_at: "2026-11-21T12:00:00Z" };
const issuedLive: IssuedDiagnosticUpload = { upload_id: "00000000-0000-4000-8000-000000000109", url: "https://r2.test/diagnostics/tenant/episode/live.json.gz?signature=y", headers: {}, expires_at: "2026-11-21T12:00:00Z" };

const upload = (test: ReturnType<typeof chainTelemetry>, request: { trigger: "report"; reportId: string } | { trigger: "live"; liveRequestId: string }, fetch: typeof globalThis.fetch) =>
  uploadDiagnosticBundle({
    apiBaseURL: "https://api.test",
    tenantId: "00000000-0000-4000-8000-000000000107",
    credential: "media-token",
    request,
    bundle: async () => new Uint8Array([0x1f, 0x8b, 2]),
    obs: test.outbox.obs,
    fetch,
    sha256: async () => "ab".repeat(32),
    isHidden: () => false,
  }).catch(() => undefined);

async function drive(run: "positive" | "healthy"): Promise<readonly LedgerFrame[]> {
  const test = chainTelemetry();
  try {
    await test.sync();
    await test.outbox.obs.op("problem_report.send", { journey_id: journey, picked_symptom: "audio.not_heard" }, (scope) => {
      scope.set({ http_status: 200, report_id: reportId, chk_code: "CHK-7Q2M" });
      return Promise.resolve({ report_id: reportId });
    });
    if (run === "positive") {
      // A live request's upload completed beside the report's aborted one.
      const answersLive = [() => Response.json(issuedLive), () => new Response(null, { status: 200 }), () => Response.json({ stored: true })];
      let indexLive = 0;
      const fetchLive: typeof globalThis.fetch = async () => answersLive[indexLive++]();
      await upload(test, { trigger: "live", liveRequestId }, fetchLive);
    }
    const answers = run === "positive" ? [() => Response.json(issued), () => Promise.reject(new TypeError("offline"))] : [() => Response.json(issued), () => new Response(null, { status: 200 }), () => Response.json({ stored: true })];
    let index = 0;
    const fetch: typeof globalThis.fetch = async () => {
      const answer = answers[index++];
      if (!answer) throw new TypeError(`unexpected fetch ${index}`);
      return answer();
    };
    await upload(test, { trigger: "report", reportId }, fetch);
    test.advance(1_000);
    await test.outbox.flush();
    await test.outbox.dispose();
    return test.frames;
  } finally {
    test.restore();
  }
}

describe(symptom, () => {
  it("positive: the issued upload's PUT dies on the network and records error(report.network)", async () => {
    const frames = await drive("positive");
    const upload = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.upload"));
    expect(upload).toEqual([
      expect.objectContaining({ kind: "op", outcome: "ok", upload_trigger: "live", live_request_id: liveRequestId, diagnostic_upload_id: issuedLive.upload_id }),
      expect.objectContaining({ kind: "op", outcome: "error", reason_code: "report.network", upload_trigger: "report", report_id: reportId, diagnostic_upload_id: issued.upload_id }),
    ]);
    handOff(frames, chainFile("positive"));
  });

  it("healthy: the upload completes and records ok", async () => {
    const frames = await drive("healthy");
    const upload = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.upload"));
    expect(upload).toEqual([expect.objectContaining({ kind: "op", outcome: "ok", upload_trigger: "report", report_id: reportId, diagnostic_upload_id: issued.upload_id, http_status: 200, bytes: 3 })]);
    handOff(frames, chainFile("healthy"));
  });
});
