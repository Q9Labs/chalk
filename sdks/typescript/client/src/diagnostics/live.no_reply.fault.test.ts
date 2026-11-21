// Fault scenario for the symptom live.no_reply (observability/registry/areas/report.json), hop (a) of its chain.
// The target tab's event loop stalls for 60 s past the request's deadline: the `live_request` frame is delivered but
// never dispatched, so it leaves no client record — Sync's deliver evidence and the absent ack carry the hop, while an
// earlier request's received+stored flow ran beside it.
// In the healthy control the client records `live_request.received` and one `report.upload` ok. The scenario drives the
// real kernel, outbox and `createLiveIntrospection`; the frames are compared with the committed hand-off files.
// CHALK_CHAIN_WRITE=1 rewrites them.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { symptom } from "../../../../../observability/rules/live.no_reply.mjs";
import type { ParsedAccessGrant } from "../access/grant";
import type { LedgerFrame } from "../telemetry/types";
import { chainTelemetry, handOff } from "./chain.test.helpers";
import { createLiveIntrospection } from "./live";
import type { IssuedDiagnosticUpload } from "./upload";

const CHAIN = new URL("../../../../../observability/fixtures/live.no_reply/chain/", import.meta.url);
const framesFile = (run: "positive" | "healthy") => new URL(`client-frames.live.no_reply.${run}.json`, CHAIN);
const chainFile = (run: "positive" | "healthy") => ({ read: () => readFileSync(framesFile(run), "utf8"), write: process.env.CHALK_CHAIN_WRITE === "1" ? (text: string) => writeFileSync(framesFile(run), text) : undefined });
const liveRequestId = "00000000-0000-4000-8000-000000000110";
const priorRequestId = "00000000-0000-4000-8000-000000000116";
const priorIssued: IssuedDiagnosticUpload = { upload_id: "00000000-0000-4000-8000-000000000117", url: "https://r2.test/diagnostics/tenant/episode/prior.json.gz?signature=p", headers: {}, expires_at: "2026-11-21T12:00:00Z" };
const access = {
  subject: { tenantId: "00000000-0000-4000-8000-000000000107", episodeId: "1f8fad5b-d9cb-469f-a165-70867728950e", participantId: "00000000-0000-4000-8000-000000000108" },
  media: { token: "media-token" },
} as unknown as ParsedAccessGrant;
const issued: IssuedDiagnosticUpload = { upload_id: "00000000-0000-4000-8000-000000000111", url: "https://r2.test/diagnostics/tenant/episode/upload.json.gz?signature=x", headers: {}, expires_at: "2026-11-21T12:00:00Z" };

async function drive(run: "positive" | "healthy"): Promise<readonly LedgerFrame[]> {
  const test = chainTelemetry();
  try {
    await test.sync();
    if (run === "positive") {
      // The earlier request's whole flow ran before the stall: the frame was
      // received and its upload issued, PUT and stored through the real handler.
      test.outbox.obs.fact("live_request.received", { live_request_id: priorRequestId });
      const priorAnswers = [() => Response.json(priorIssued), () => new Response(null, { status: 200 }), () => Response.json({ stored: true })];
      let priorIndex = 0;
      const priorFetch: typeof globalThis.fetch = async () => {
        const answer = priorAnswers[priorIndex++];
        if (!answer) throw new TypeError(`unexpected fetch ${priorIndex}`);
        return answer();
      };
      createLiveIntrospection({
        apiBaseURL: "https://api.test",
        access,
        telemetry: test.outbox,
        connection: () => ({ phase: "live" }),
        fetch: priorFetch,
        isHidden: () => false,
      })({ requestId: priorRequestId, expiresAtMs: WALL_ORIGIN + 60_000 });
      test.advance(1_000);
      await vi.waitFor(async () => {
        await test.outbox.flush();
        expect(test.frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.upload")).length).toBe(1);
      });
    }
    if (run === "healthy") {
      // The seat is the telemetry credential's, stamped at intake: V1SyncClient emits only the request id.
      test.outbox.obs.fact("live_request.received", { live_request_id: liveRequestId });
      const answers = [() => Response.json(issued), () => new Response(null, { status: 200 }), () => Response.json({ stored: true })];
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
        expect(test.frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.upload")).length).toBe(1);
      });
    }
    await test.outbox.dispose();
    return test.frames;
  } finally {
    test.restore();
  }
}

const WALL_ORIGIN = 1_795_599_000_000;

describe(symptom, () => {
  it("positive: the stalled tab never dispatches the frame, so the client posts nothing about the request", async () => {
    const frames = await drive("positive");
    // The prior request's receipt and stored upload are the client's records;
    // the fault request leaves none — only its own id is never named.
    expect(frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && "live_request_id" in event && event.live_request_id === liveRequestId))).toEqual([]);
    handOff(frames, chainFile("positive"));
  });

  it("healthy: the client records the receipt and the stored upload", async () => {
    const frames = await drive("healthy");
    const received = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "live_request.received"));
    expect(received).toEqual([expect.objectContaining({ kind: "fact", live_request_id: liveRequestId })]);
    const upload = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.upload"));
    expect(upload).toEqual([expect.objectContaining({ kind: "op", outcome: "ok", upload_trigger: "live", live_request_id: liveRequestId, diagnostic_upload_id: issued.upload_id })]);
    handOff(frames, chainFile("healthy"));
  });
});
