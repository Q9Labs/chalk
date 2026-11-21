// Fault scenario for the symptom report.send_failed (observability/registry/areas/report.json), hop (a) of its chain.
// The browser blocks the report send before the API: `problem_report.send` records error(report.network) for the
// journey and the dialog commits the send_failed state; in the healthy control the send stores and the dialog commits
// sent with the report's code. The ops and surfaces are emitted the way web's problemReporter and the dialog emit them,
// into the real kernel and outbox, and the frames are compared with the committed hand-off files. CHALK_CHAIN_WRITE=1
// rewrites them.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { symptom } from "../../../../../observability/rules/report.send_failed.mjs";
import { failure } from "../obs/kernel";
import type { LedgerFrame } from "../telemetry/types";
import { chainTelemetry, handOff } from "./chain.test.helpers";

const CHAIN = new URL("../../../../../observability/fixtures/report.send_failed/chain/", import.meta.url);
const framesFile = (run: "positive" | "healthy") => new URL(`client-frames.report.send_failed.${run}.json`, CHAIN);
const chainFile = (run: "positive" | "healthy") => ({ read: () => readFileSync(framesFile(run), "utf8"), write: process.env.CHALK_CHAIN_WRITE === "1" ? (text: string) => writeFileSync(framesFile(run), text) : undefined });
const journey = "00000000-0000-4000-8000-000000000102";
const priorJourney = "00000000-0000-4000-8000-000000000109";
const priorReport = "00000000-0000-4000-8000-000000000110";

async function drive(run: "positive" | "healthy"): Promise<readonly LedgerFrame[]> {
  const test = chainTelemetry();
  try {
    await test.sync();
    if (run === "positive") {
      // An earlier dialog cycle beside the fault: reports were briefly
      // unavailable so it blocked, and a later send stored with the code.
      const blocked = test.outbox.obs.surface("report.dialog", { dialog_state: "blocked", blocked_reason: "reports_unavailable" });
      test.advance(500);
      blocked.dismiss();
      await test.outbox.obs.op("problem_report.send", { journey_id: priorJourney, picked_symptom: "audio.not_heard" }, (scope) => {
        scope.set({ http_status: 200, report_id: priorReport, chk_code: "CHK-9P4X" });
        return Promise.resolve({ report_id: priorReport, code: "CHK-9P4X" });
      });
      const sent = test.outbox.obs.surface("report.dialog", { dialog_state: "sent", journey_id: priorJourney, picked_symptom: "audio.not_heard" });
      test.advance(500);
      sent.dismiss();
    }
    const form = test.outbox.obs.surface("report.dialog", { dialog_state: "form", picked_symptom: "audio.not_heard" });
    test.advance(2_000);
    if (run === "positive") {
      await expect(test.outbox.obs.op("problem_report.send", { journey_id: journey, picked_symptom: "audio.not_heard" }, () => Promise.reject(failure("report.network", new TypeError("offline"))))).rejects.toThrow();
      test.advance(1_000);
      form.dismiss();
      const failed = test.outbox.obs.surface("report.dialog", { dialog_state: "send_failed", journey_id: journey, picked_symptom: "audio.not_heard" });
      test.advance(3_000);
      failed.dismiss();
    } else {
      await test.outbox.obs.op("problem_report.send", { journey_id: journey, picked_symptom: "audio.not_heard" }, (scope) => {
        scope.set({ http_status: 200, report_id: "00000000-0000-4000-8000-000000000103", chk_code: "CHK-7Q2M" });
        return Promise.resolve({ report_id: "00000000-0000-4000-8000-000000000103", code: "CHK-7Q2M" });
      });
      test.advance(1_000);
      form.dismiss();
      const sent = test.outbox.obs.surface("report.dialog", { dialog_state: "sent", journey_id: journey, picked_symptom: "audio.not_heard" });
      test.advance(3_000);
      sent.dismiss();
    }
    await test.outbox.flush();
    await test.outbox.dispose();
    return test.frames;
  } finally {
    test.restore();
  }
}

describe(symptom, () => {
  it("positive: a blocked send records error(report.network) and the dialog commits send_failed", async () => {
    const frames = await drive("positive");
    const send = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "problem_report.send"));
    expect(send).toEqual([
      expect.objectContaining({ kind: "op", outcome: "ok", journey_id: priorJourney, report_id: priorReport, chk_code: "CHK-9P4X", http_status: 200 }),
      expect.objectContaining({ kind: "op", outcome: "error", reason_code: "report.network", journey_id: journey, picked_symptom: "audio.not_heard" }),
    ]);
    const surfaces = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.dialog"));
    expect(surfaces.map((surface) => "dialog_state" in surface && surface.dialog_state)).toEqual(["blocked", "blocked", "sent", "sent", "form", "form", "send_failed", "send_failed"]);
    handOff(frames, chainFile("positive"));
  });

  it("healthy: the send stores and the dialog commits sent", async () => {
    const frames = await drive("healthy");
    const send = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "problem_report.send"));
    expect(send).toEqual([expect.objectContaining({ kind: "op", outcome: "ok", journey_id: journey, chk_code: "CHK-7Q2M", http_status: 200 })]);
    const surfaces = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.dialog"));
    expect(surfaces.map((surface) => "dialog_state" in surface && surface.dialog_state)).toEqual(["form", "form", "sent", "sent"]);
    handOff(frames, chainFile("healthy"));
  });
});
