import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { appTelemetry } from "../../../../../sdks/typescript/client/src/telemetry/app";
import { createTestOutbox } from "../../../../../sdks/typescript/client/src/telemetry/outbox.test.helpers";
import { CATALOGUE } from "../../../../../scripts/diagnose-call/proof/catalogue.mjs";
import { judgeFixture, ruleResult } from "../../../../../scripts/diagnose-call/proof/rows.mjs";
import { entranceReducer, pendingRelease } from "./entrance-machine";
import { releaseForRejoin } from "./rejoin-release";

const code = "rejoin.refused";

it.each(["positive", "healthy"])("%s: judges the previous arrival's release on explicit Rejoin", async (variant) => {
  const test = createTestOutbox();
  const client = { telemetry: appTelemetry(test.outbox), close: vi.fn(() => test.outbox.dispose()) };
  const failure = new Error("old arrival release failed");
  const release = vi.fn(async () => {
    if (variant === "positive") throw failure;
  });
  const call = {
    phase: "left",
    offerSignUp: false,
    tenantId: undefined,
    callName: undefined,
    failure: undefined,
    release,
    releaseForRejoin: () => releaseForRejoin(release, client),
  };
  const ended = { phase: "ended", attempt: 1, rejoining: false, call };
  const started = entranceReducer(ended, { type: "started", fromStep: false });
  const pending = pendingRelease(started);
  if (!pending) throw new Error("Rejoin did not wait for the previous arrival");
  try {
    if (variant === "positive") {
      await expect(pending()).rejects.toBe(failure);
      const failed = entranceReducer(started, { type: "failed", attempt: 1, failure: { message: failure.message, retryable: true } });
      expect(failed).toMatchObject({ phase: "ended", rejoining: false });
      expect(client.close).not.toHaveBeenCalled();
    } else {
      await expect(pending()).resolves.toBeUndefined();
      expect(entranceReducer(started, { type: "rejoinReleased", attempt: 1 })).toMatchObject({ phase: "arriving", attempt: 2 });
      expect(client.close).toHaveBeenCalledOnce();
    }
    await test.outbox.flush();
    expect(test.accepted).toHaveLength(1);
    const [accepted] = test.accepted;
    expect(accepted?.type).toBe("rejoin_release");
    const input = JSON.parse(readFileSync(new URL(`../../../../../observability/fixtures/${code}/${variant}.json`, import.meta.url), "utf8"));
    const [placed] = input.rows;
    const row = { ...placed, event_id: accepted?.event_id, rejoin_release: accepted?.rejoin_release };
    const { verdict, dropped } = judgeFixture({ ...input, rows: [row] }, CATALOGUE, code);
    expect(dropped).toEqual([]);
    expect(ruleResult(verdict, code)).toEqual({ checked: 1, eligible: 1, findings: variant === "positive" ? 1 : 0 });
    if (variant === "positive") expect(verdict.findings.find((finding) => finding.code === code)).toMatchObject({ subject: `pt:${row.participant_id}`, hop: "release", module: "web.space_entry" });
  } finally {
    await test.outbox.dispose();
  }
});
