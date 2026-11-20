// @ts-check
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { measureRecord, renderText } from "../output/text.mjs";
import { itemView } from "../output/views.mjs";
import { CATALOGUE, RULES } from "./catalogue.mjs";
import { judgeFixture, ruleResult } from "./rows.mjs";

const symptom = "join.no_media";
/** @param {"positive" | "healthy"} name @returns {import("./rows.mjs").Fixture} */
const fixture = (name) => JSON.parse(readFileSync(new URL(`../../../observability/fixtures/${symptom}/${name}.json`, import.meta.url), "utf8"));

test("initial transport failure names the Participant and hop in diagnose", () => {
  const recorded = fixture("positive");
  const { verdict, dropped } = judgeFixture(recorded, CATALOGUE, symptom);
  assert.deepEqual(dropped, []);
  assert.equal(verdict.findings.filter(({ backstop }) => backstop === "UNEXPLAINED").length, 0);

  const declaration = recorded.declaration;
  assert.equal(declaration.kind, "episode");
  const item = { kind: declaration.kind, id: declaration.id, tenant: declaration.tenant, declaration };
  const tenant = { id: declaration.tenant, name: "Test", tz: "UTC" };
  const ctx = { asof_ms: recorded.asof_ms, rules: RULES, catalogue: CATALOGUE, paging: { limit: 20, cursor: null, budget: null }, measure: measureRecord };
  const text = renderText(itemView({ item, tenant, ctx, status: { state: "current", stored: { item, declaration: "", fingerprint: "", verdict } } }));
  assert.match(text, /^f_[a-z0-9]+ broken join\.no_media pt_a100\("Seat A"\) .* hop=transport module=sdk\.media upstream=unknown ev=ev_[a-z0-9]+$/mu);
  assert.match(text, /^fact: media\.transport_timeout: the peer transport timed out before RTP flowed /mu);
});

test("the listen-only control needs a placeable outcome for every observed Join", () => {
  const recorded = fixture("healthy");
  const judge = (/** @type {import("./rows.mjs").Row[]} */ rows) => ruleResult(judgeFixture({ ...recorded, rows }, CATALOGUE, symptom).verdict, symptom);
  assert.equal(judgeFixture(recorded, CATALOGUE, symptom).verdict.coverage.state, "complete");
  assert.deepEqual(judge(recorded.rows), { findings: 0, checked: 1, eligible: 1 });

  const withoutReady = recorded.rows.filter((row) => row.join_signal !== "listen_only");
  assert.deepEqual(judge(withoutReady), { findings: 0, checked: 0, eligible: 1 });
  assert.deepEqual(judge([]), { findings: 0, checked: 0, eligible: 1 });

  const [first] = recorded.rows;
  const unfinished = { ...first, event_id: "4c8e67f9-7425-40de-944b-e07fc1f90ae8", join_attempt_id: "4c8e67f9-7425-40de-944b-e07fc1f90ae9", join_signal: "ice_checking" };
  assert.deepEqual(judge([...recorded.rows, unfinished]), { findings: 0, checked: 0, eligible: 1 });
});

test("an explicit failure stays proved with no earlier milestones or watermark", () => {
  const recorded = fixture("positive");
  const rows = recorded.rows.filter((row) => row.join_signal === "transport_timeout");
  const { verdict } = judgeFixture({ ...recorded, rows, watermarks: [] }, CATALOGUE, symptom);
  assert.deepEqual(ruleResult(verdict, symptom), { findings: 1, checked: 0, eligible: 1 });
});
