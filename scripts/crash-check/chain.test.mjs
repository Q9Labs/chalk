// @ts-check
// Hop (d) of every slice-9 chain: assembles the symptom's positive and healthy fixtures from the committed hand-off rows
// (client frames posted through the real upload route, plus the Sync/SFU/Postgres close rows the Postgres hop wrote) and
// judges them through the real kernel. CHALK_CHAIN_CODE selects the symptom; CHALK_CHAIN_WRITE=1 rewrites the fixtures.
//
//   CHALK_CHAIN_CODE=page.tab_died node --test scripts/crash-check/chain.test.mjs
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "node:test";
import { CATALOGUE } from "../diagnose-call/proof/catalogue.mjs";
import { judgeFixture, ruleResult } from "../diagnose-call/proof/rows.mjs";

const CODE = process.env.CHALK_CHAIN_CODE;
assert.ok(CODE, "CHALK_CHAIN_CODE names the symptom whose chain this hop finishes");

const FIXTURES = `observability/fixtures/${CODE}`;
const root = new URL("../../", import.meta.url);
/** @param {string} path */
const read = (path) => JSON.parse(readFileSync(new URL(path, root), "utf8"));
const has = (path) => existsSync(new URL(path, root));

// The seat the chain's API hop credentialed: same subject as apps/api/internal/httpapi/telemetry_chain_test.go.
const TENANT = "c1000000-0000-4000-8000-000000000001";
const EPISODE = "0f8fad5b-d9cb-469f-a165-70867728950e";
const SEAT = "a1000000-0000-4000-8000-000000000001";
const ATTEMPT = "00000000-0000-4000-8000-000000000004"; // the run's client_session_id, which the proof binds as its attempt
const WINDOW = { from_ms: 1_795_699_900_000, to_ms: 1_795_702_000_000 };
const ASOF = 1_795_702_600_000;

const seatDecl = {
  kind: "episode",
  id: EPISODE,
  tenant: TENANT,
  features: [],
  window: WINDOW,
  seats: [{ participant: SEAT, name: "Seat A", role: "participant", can_publish: true, generations: [1], connections: [], window: WINDOW, person: { kind: "user", id: "b1000000-0000-4000-8000-000000000001", name: "Seat A" } }],
};

// app.crashed_at_launch is item-scoped: the check reads the new run's own rows under the attempt, not a seat's.
const attemptDecl = { kind: "attempt", id: ATTEMPT, tenant: TENANT, window: WINDOW };

const DECLARATIONS = { "app.crashed_at_launch": attemptDecl };

const DESCRIPTIONS = {
  "page.crashed": "The seat's page threw at render and reported render_error with the crash fallback shown; the rows are the chain's posted frames.",
  "page.uncaught_error": "The seat's page reported an uncaught error with its real error fields; the rows are the chain's posted frames.",
  "page.tab_died": "The seat's previous tab died mid-call: the next run's scan found its marker, Sync's abnormal close and the media session's crash outcome are the Postgres hop's rows.",
  "app.crashed": "The seat's app died in the foreground: the marker says live/active, the OS exit says crash, and the dead run's js_fatal and render crash rows name the error.",
  "app.crashed_at_launch": "The attempt's run found a launch marker that never reached js_ready, and the OS exit reason is a crash.",
  "app.killed_in_background": "The seat's app died while backgrounded: the marker's last app_state is background and the OS exit reason is a kill.",
  "perf.ui_unresponsive": "The seat's main thread blocked inside a 30 s window: its heartbeat's long-task max crossed the threshold.",
  "perf.memory_pressure": "The seat ran under memory pressure: a low-memory warning and a heap near its limit.",
  "perf.device_overloaded": "The seat's device was overloaded: a measured critical CPU pressure row.",
  healthy: "The seat's run is quiet: the rows are the chain's healthy-run frames and no check finds a problem.",
};

/** @param {"positive" | "healthy"} run */
function chainFixture(run) {
  const files = [`api-rows.${run}.json`, `server-rows.${run}.json`, `db-rows.${run}.json`].filter((name) => has(`${FIXTURES}/chain/${name}`));
  const chain = files.map((name) => `${FIXTURES}/chain/${name}`);
  const rows = chain.flatMap((path) => read(path));
  return { description: run === "healthy" ? DESCRIPTIONS.healthy : DESCRIPTIONS[CODE], asof_ms: ASOF, declaration: DECLARATIONS[CODE] ?? seatDecl, chain, rows };
}

/** @param {"positive" | "healthy"} run */
function handOff(run) {
  const fixture = chainFixture(run);
  const path = `${FIXTURES}/${run}.json`;
  const text = `${JSON.stringify(fixture, null, 2)}\n`;
  if (process.env.CHALK_CHAIN_WRITE === "1") writeFileSync(new URL(path, root), text);
  assert.deepEqual(read(path), JSON.parse(text), `${path} is not the chain's rows: run the chain in order with CHALK_CHAIN_WRITE=1`);
  return fixture;
}

describe(`${CODE}'s chain ends in the kernel's verdict`, () => {
  it("positive: the chain's rows give the finding", () => {
    const fixture = handOff("positive");
    const { verdict, dropped } = judgeFixture(fixture, CATALOGUE, CODE);
    assert.deepEqual(dropped, []);
    assert.equal(ruleResult(verdict, CODE).findings >= 1, true, `no ${CODE} finding in ${JSON.stringify(verdict.findings)}`);
    const [finding] = verdict.findings.filter((entry) => entry.code === CODE);
    assert.equal(finding?.outcome, "broken");
  });

  it("healthy: the chain's rows check the seat and give no finding", () => {
    const fixture = handOff("healthy");
    const { verdict, dropped } = judgeFixture(fixture, CATALOGUE, CODE);
    assert.deepEqual(dropped, []);
    const result = ruleResult(verdict, CODE);
    assert.equal(result.findings, 0, JSON.stringify(verdict.findings));
    assert.equal(result.checked, result.eligible, JSON.stringify(verdict.coverage?.gaps ?? []));
    assert.ok(result.eligible > 0);
  });
});
