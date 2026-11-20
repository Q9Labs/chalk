// @ts-check
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CATALOGUE, RULES } from "./catalogue.mjs";
import { check, statusOf } from "./check.mjs";
import { openWorld } from "./fixture-world.mjs";
import { ASOF, IDS, nov18 } from "../fixtures/nov18.mjs";

const DAY = { tenant: "1f0c3b2a-7d6e-4c5b-9a8f-2e1d0c9b8a7f", from_ms: Date.parse("2026-11-17T19:00:00Z"), to_ms: Date.parse("2026-11-18T19:00:00Z") };
const options = { catalogue: CATALOGUE, rules: RULES, asof_ms: ASOF };

describe("check", () => {
  it("enumerates Episodes, the attempt that never became one and the pending job, and judges only what is not current", async () => {
    const { ports } = await openWorld(nov18(), { catalogue: CATALOGUE, rules: RULES });
    const results = await check(DAY, ports, options);
    const byId = Object.fromEntries(results.map((result) => [result.item.id, result]));
    assert.deepEqual(Object.keys(byId).sort(), [IDS.ep9feb, IDS.ep7a21, IDS.ep31aa, IDS.ep5c0d, IDS.attempt, IDS.job].sort());
    assert.equal(byId[IDS.ep7a21].action, "checked");
    assert.equal(byId[IDS.ep7a21].verdict.outcome, "healthy");
    assert.equal(byId[IDS.ep31aa].action, "rechecked");
    assert.equal(byId[IDS.ep31aa].was, "healthy");
    assert.equal(byId[IDS.ep31aa].verdict.findings[0]?.backstop, "BLIND_SPOT");
    assert.equal(byId[IDS.attempt].verdict.findings[0]?.code, "entry.unresolved");
    assert.equal(byId[IDS.job].verdict.findings[0]?.code, "recording.not_ready");
    assert.ok(
      byId[IDS.job].verdict.coverage.gaps.some((gap) => gap.kind === "open"),
      "a pending job is open, so never healthy",
    );
    assert.equal(byId[IDS.ep9feb].action, "current");
  });

  it("is idempotent: a second run finds everything current", async () => {
    const { ports } = await openWorld(nov18(), { catalogue: CATALOGUE, rules: RULES });
    await check(DAY, ports, options);
    const again = await check(DAY, ports, options);
    assert.ok(again.every((result) => result.action === "current"));
  });

  it("rechecks a verdict whose rules changed, and says so before it does", async () => {
    const { items, ports } = await openWorld(nov18(), { catalogue: CATALOGUE, rules: RULES });
    const ep = items.find((item) => item.id === IDS.ep9feb);
    assert.ok(ep);
    const status = await statusOf(ep, ports, "newrules");
    assert.equal(status.state === "stale" && status.why, "rules");
    const results = await check({ item: { kind: "episode", id: IDS.ep9feb } }, ports, { ...options, rules: "newrules" });
    assert.equal(results[0].action, "rechecked");
    assert.equal(results[0].verdict.rules, "newrules");
  });

  it("keeps verdicts in a store file across runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diagnose-store-"));
    try {
      const store = join(dir, "verdicts.json");
      const first = await openWorld(nov18(), { catalogue: CATALOGUE, rules: RULES, store });
      await check(DAY, first.ports, options);
      const second = await openWorld(nov18(), { catalogue: CATALOGUE, rules: RULES, store });
      const ep = second.items.find((item) => item.id === IDS.ep7a21);
      assert.ok(ep);
      assert.equal((await statusOf(ep, second.ports, RULES)).state, "current");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
