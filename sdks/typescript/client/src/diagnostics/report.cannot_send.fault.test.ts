// Fault scenario for the symptom report.cannot_send (observability/registry/areas/report.json), hop (a) of its chain.
// An earlier send already died on the network; when the participant retries, the call credential's five-minute lifetime
// has expired so the reopened dialog shows blocked(credential_expired) and stays shown 85 s; in the healthy control the
// form commits and dismisses without a block.
// The surfaces are emitted the way the dialog's <ObservedSurface> emits them, into the real kernel and outbox, and the
// frames the outbox posts are compared with the committed hand-off files. CHALK_CHAIN_WRITE=1 rewrites them.
import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { symptom } from "../../../../../observability/rules/report.cannot_send.mjs";
import { failure } from "../obs/kernel";
import type { LedgerFrame } from "../telemetry/types";
import { chainTelemetry, handOff } from "./chain.test.helpers";

const CHAIN = new URL("../../../../../observability/fixtures/report.cannot_send/chain/", import.meta.url);
const framesFile = (run: "positive" | "healthy") => new URL(`client-frames.report.cannot_send.${run}.json`, CHAIN);
const chainFile = (run: "positive" | "healthy") => ({ read: () => readFileSync(framesFile(run), "utf8"), write: process.env.CHALK_CHAIN_WRITE === "1" ? (text: string) => writeFileSync(framesFile(run), text) : undefined });
const priorJourney = "00000000-0000-4000-8000-000000000118";

async function drive(run: "positive" | "healthy"): Promise<readonly LedgerFrame[]> {
  const test = chainTelemetry();
  try {
    await test.sync();
    if (run === "positive") {
      // The first send died on the network; the dialog committed send_failed
      // for that journey before the participant reopened it.
      const firstForm = test.outbox.obs.surface("report.dialog", { dialog_state: "form", picked_symptom: "audio.not_heard" });
      test.advance(1_000);
      await expect(test.outbox.obs.op("problem_report.send", { journey_id: priorJourney, picked_symptom: "audio.not_heard" }, () => Promise.reject(failure("report.network", new TypeError("offline"))))).rejects.toThrow();
      firstForm.dismiss();
      const sendFailed = test.outbox.obs.surface("report.dialog", { dialog_state: "send_failed", journey_id: priorJourney, picked_symptom: "audio.not_heard" });
      test.advance(2_000);
      sendFailed.dismiss();
    }
    const form = test.outbox.obs.surface("report.dialog", { dialog_state: "form", picked_symptom: "audio.not_heard" });
    test.advance(2_000);
    form.dismiss();
    if (run === "positive") {
      const blocked = test.outbox.obs.surface("report.dialog", { dialog_state: "blocked", blocked_reason: "credential_expired" });
      test.advance(85_000);
      blocked.dismiss();
    }
    await test.outbox.flush();
    await test.outbox.dispose();
    return test.frames;
  } finally {
    test.restore();
  }
}

describe(symptom, () => {
  it("positive: the open dialog turns blocked when the credential expires, and stays blocked past the threshold", async () => {
    const frames = await drive("positive");
    const surfaces = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.dialog"));
    expect(surfaces.map((surface) => "dialog_state" in surface && surface.dialog_state)).toEqual(["form", "form", "send_failed", "send_failed", "form", "form", "blocked", "blocked"]);
    handOff(frames, chainFile("positive"));
  });

  it("healthy: the form shows and dismisses without ever blocking", async () => {
    const frames = await drive("healthy");
    const surfaces = frames.flatMap((frame) => frame.events.filter((event) => "kind" in event && event.name === "report.dialog"));
    expect(surfaces).toEqual([expect.objectContaining({ kind: "surface", surface_state: "shown", dialog_state: "form" }), expect.objectContaining({ kind: "surface", surface_state: "dismissed", dialog_state: "form" })]);
    handOff(frames, chainFile("healthy"));
  });
});
