// @ts-check
// fallow-ignore-file complexity -- each branch is a case of this test; the CRAP estimate reads a test's own branches as untested.
/**
 * The independent judge's attacks on the proof kernel, each reproduced as it was run: a rule that passes on absent witnesses, an
 * Episode binding that ignores the tenant, a sealed bundle whose watermarks could still be changed, an open tail that starts exactly
 * at a check's end, and one row that witnesses two facts. Every id here is made up.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { openBundle } from "./bundle.mjs";
import { CATALOGUE } from "./catalogue.mjs";
import { origin, uncovered, watermark } from "./evidence.mjs";
import { ITEM, profileFor } from "./profile.mjs";
import { completeWatermarks, judgeFixture, ruleResult } from "./rows.mjs";
import { judge, rulesVersion } from "./verdict.mjs";

/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./profile.mjs").Declaration} Declaration */
/** @typedef {import("./rows.mjs").Fixture} Fixture */

const CODE = "end.wrong_screen";
/** @type {Fixture} */
const healthy = JSON.parse(readFileSync(new URL(`../../../observability/fixtures/${CODE}/healthy.json`, import.meta.url), "utf8"));
/** The healthy fixture is the chain's rows for its seats, so each seat is one eligible subject. */
const SEATS = healthy.declaration.kind === "episode" ? healthy.declaration.seats.length : 0;
const OTHER_TENANT = "c1000000-0000-4000-8000-0000000000ff";

/** The fixture judged as the judge ran it: every source the check reads complete, and the report stream complete too. @param {Fixture} fixture */
function judgedComplete(fixture) {
  const only = CATALOGUE.filter((def) => def.code === CODE);
  const report = { source: "report", subject: ITEM, complete_to_ms: fixture.asof_ms, evidence_gaps: [], emits: ["report.problem"], build: "report fixture" };
  const { verdict } = judgeFixture({ ...fixture, watermarks: [...completeWatermarks(fixture.declaration, only, fixture.asof_ms), report] }, CATALOGUE, CODE);
  return { verdict, rule: ruleResult(verdict, CODE) };
}

/** @param {import("./verdict.mjs").Verdict} verdict */
const unboundWhy = (verdict) => [...new Set(verdict.coverage.gaps.flatMap((gap) => (gap.kind === "unbound" ? [gap.why] : [])))];

describe("1a and 1b: the worked rule fails closed", () => {
  it("passes the healthy fixture, whose rows carry the Episode's tenant", () => {
    const { verdict, rule } = judgedComplete(healthy);
    assert.equal(verdict.outcome, "healthy");
    assert.deepEqual(rule, { findings: 0, checked: SEATS, eligible: SEATS });
  });

  it("does not pass the judge's healthy rows, which name no tenant, because no row binds", () => {
    const rows = healthy.rows.map(({ tenant_id: _tenant, ...row }) => row);
    const { verdict, rule } = judgedComplete({ ...healthy, rows });
    assert.equal(verdict.outcome, "unknown");
    assert.equal(rule.checked, 0);
    assert.deepEqual(unboundWhy(verdict), ["names no Tenant"]);
  });

  it("does not pass zero rows under complete watermarks", () => {
    const { verdict, rule } = judgedComplete({ ...healthy, rows: [] });
    assert.equal(verdict.outcome, "unknown");
    assert.deepEqual(rule, { findings: 0, checked: 0, eligible: SEATS });
  });

  it("does not bind the same rows stamped with another tenant", () => {
    const rows = healthy.rows.map((row) => ({ ...row, tenant_id: OTHER_TENANT }));
    const { verdict, rule } = judgedComplete({ ...healthy, rows });
    assert.equal(verdict.outcome, "unknown");
    assert.equal(rule.checked, 0);
    assert.deepEqual(unboundWhy(verdict), ["names another Tenant"]);
  });
});

const TENANT = "c2000000-0000-4000-8000-000000000001";
const ASOF = 1_000_000;
/** @type {Declaration} */
const EPISODE = { kind: "episode", id: "e2000000-0000-4000-8000-000000000001", tenant: TENANT, features: [], window: { from_ms: 0, to_ms: 100_000 }, seats: [] };
const complete = (/** @type {string} */ source, /** @type {string[]} */ emits) => ({ source, subject: ITEM, complete_to_ms: ASOF, evidence_gaps: [], emits, build: `${source} test` });
const END_ROW = { id: "e2000000-0000-4000-8000-0000000000e1", fact: "end.episode", source: "sync", origin: origin.measured("sync"), subject: { episode: EPISODE.id, tenant: TENANT }, window: { from_ms: 100_000, to_ms: 100_000 }, claim: "ended_by_participant", value: {}, failure: false, query: "q" };

/**
 * A check whose rule always passes, the way a careless slice might write one.
 * @param {Partial<CheckDef>} [extra]
 * @returns {CheckDef}
 */
const alwaysPass = (extra = {}) => ({
  code: "end.always_pass",
  item: "episode",
  per: "item",
  applies: () => true,
  requires: [{ fact: "end.episode", from: ["sync"], query: "q" }],
  optional: [],
  healthy_absent: [],
  expected: "the Episode's end is witnessed",
  decide: () => ({ status: "pass" }),
  ...extra,
});

/** @param {CheckDef} def @param {{ observations?: object[], watermarks?: object[] }} evidence */
function verdictOf(def, { observations = [], watermarks = [complete("sync", ["end.episode"]), complete("report", ["report.problem"])] }) {
  const bundle = openBundle(profileFor(EPISODE, [def], ASOF), { asof_ms: ASOF });
  for (const o of observations) bundle.add(/** @type {any} */ (o));
  for (const w of watermarks) bundle.watermark(/** @type {any} */ (w));
  return judge(bundle.seal(), [def], { rules: rulesVersion([def], []), prior: null });
}

describe("1a: the kernel holds a pass to its required witnesses", () => {
  it("turns a pass over a proven-absent required witness into unknown, naming the witness", () => {
    const verdict = verdictOf(alwaysPass(), {});
    assert.equal(verdict.outcome, "unknown");
    const gap = verdict.coverage.gaps.find((entry) => entry.kind === "check");
    assert.match(String(gap && "reason" in gap ? gap.reason : ""), /end\.episode is absent/u);
  });

  it("keeps a pass over a present required witness", () => {
    assert.equal(verdictOf(alwaysPass(), { observations: [END_ROW] }).outcome, "healthy");
  });

  it("keeps a pass over a proven absence only when the rule names that absence as healthy", () => {
    assert.equal(verdictOf(alwaysPass({ healthy_absent: ["end.episode"] }), {}).outcome, "healthy");
  });

  it("never passes a required witness whose source did not cover the window, even when absence is healthy", () => {
    const verdict = verdictOf(alwaysPass({ healthy_absent: ["end.episode"] }), { watermarks: [complete("report", ["report.problem"])] });
    assert.equal(verdict.outcome, "unknown");
  });
});

describe("1b: binding checks the tenant on every item kind", () => {
  it("leaves an attempt's row of another tenant unbound", () => {
    /** @type {CheckDef} */
    const def = { ...alwaysPass(), code: "admission.always_pass", item: "attempt", requires: [{ fact: "admission.decision", from: ["api"], query: "q" }] };
    /** @type {Declaration} */
    const attempt = { kind: "attempt", id: "a2000000-0000-4000-8000-000000000001", tenant: TENANT, window: { from_ms: 0, to_ms: 100_000 } };
    const bundle = openBundle(profileFor(attempt, [def], ASOF), { asof_ms: ASOF });
    bundle.add({ ...END_ROW, fact: "admission.decision", source: "api", origin: origin.measured("api"), subject: { attempt: attempt.id, tenant: OTHER_TENANT }, claim: "admitted" });
    assert.deepEqual(
      bundle.seal().unbound.map((entry) => entry.why),
      ["names another Tenant"],
    );
  });
});

/**
 * The paths of every object reachable from a value that could still change: an unfrozen object or array, or any Map or Set (whose
 * entries `Object.freeze` does not protect). Functions are skipped: a profile holds none, and a CheckDef is not in a bundle.
 * @param {unknown} value
 * @param {string} path
 * @param {Set<unknown>} seen
 * @returns {string[]}
 */
function mutable(value, path = "bundle", seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  if (value instanceof Map || value instanceof Set) return [`${path} is a ${value.constructor.name}`];
  const here = Object.isFrozen(value) ? [] : [path];
  return [...here, ...Object.entries(value).flatMap(([key, child]) => mutable(child, `${path}.${key}`, seen))];
}

describe("1c: a sealed bundle is immutable", () => {
  it("lets no mutable object, Map or array escape the seal", () => {
    const bundle = openBundle(profileFor(EPISODE, [alwaysPass()], ASOF), { asof_ms: ASOF });
    bundle.add(END_ROW);
    bundle.watermark(complete("sync", ["end.episode"]));
    assert.deepEqual(mutable(bundle.seal()), []);
  });

  it("cannot be given watermarks after sealing, so the judge's empty bundle stays unknown under its digest", () => {
    const def = alwaysPass({ healthy_absent: ["end.episode"] });
    const sealed = openBundle(profileFor(EPISODE, [def], ASOF), { asof_ms: ASOF }).seal();
    const before = sealed.digest;
    const marks = /** @type {any} */ (sealed.watermarks);
    try {
      for (const w of [complete("sync", ["end.episode"]), complete("report", ["report.problem"])].map(watermark)) {
        if (typeof marks.set === "function") marks.set(`${w.source}|${w.subject}`, w);
        else marks.push(w);
      }
    } catch {
      // A frozen list refuses the push, which is the point.
    }
    const verdict = judge(sealed, [def], { rules: rulesVersion([def], []), prior: null });
    assert.equal(sealed.digest, before);
    assert.equal(verdict.outcome, "unknown");
  });

  it("digests every watermark field, so two bundles that differ only in one watermark differ in digest", () => {
    const sealWith = (/** @type {object} */ w) => {
      const bundle = openBundle(profileFor(EPISODE, [alwaysPass()], ASOF), { asof_ms: ASOF });
      bundle.watermark(/** @type {any} */ (w));
      return bundle.seal().digest;
    };
    const base = complete("sync", ["end.episode"]);
    const digests = [base, { ...base, complete_to_ms: ASOF - 1 }, { ...base, emits: [] }, { ...base, build: "sync other" }, { ...base, evidence_gaps: [{ from_ms: 1, to_ms: 2, reason: "r" }] }].map(sealWith);
    assert.equal(new Set(digests).size, digests.length);
  });
});

describe("1d: evidence gaps are half-open and a check's window includes its end", () => {
  const need = { source: "sync", subject: ITEM, fact: "end.episode", window: { from_ms: 100, to_ms: 200 } };
  const withGap = (/** @type {number} */ from_ms, /** @type {number | null} */ to_ms) => watermark({ ...complete("sync", ["end.episode"]), evidence_gaps: [{ from_ms, to_ms, reason: "test" }] });
  const cases = /** @type {const} */ ([
    ["an open tail at the window's end", 200, null, "evidence_gap"],
    ["an open tail just past the window's end", 201, null, null],
    ["a gap that ends where the window starts", 50, 100, null],
    ["a gap that ends just inside the window", 50, 101, "evidence_gap"],
    ["a gap inside the window", 150, 160, "evidence_gap"],
    ["a gap that starts at the window's start", 100, 101, "evidence_gap"],
  ]);
  for (const [name, from, to, why] of cases) {
    it(`${name} [${from}, ${to ?? "open"}) is ${why ?? "covered"}`, () => {
      assert.equal(uncovered(withGap(from, to), need)?.why ?? null, why);
    });
  }

  it("covers a window complete exactly to its end, and not one complete to just before it", () => {
    assert.equal(uncovered(watermark({ ...complete("sync", ["end.episode"]), complete_to_ms: 200 }), need), null);
    assert.equal(uncovered(watermark({ ...complete("sync", ["end.episode"]), complete_to_ms: 199 }), need)?.why, "behind");
  });
});

describe("8: one row witnesses several facts, and an attempt has a pre-seat client key", () => {
  it("binds both observations of a row that feeds two facts, instead of discarding them as conflicting duplicates", () => {
    const bundle = openBundle(profileFor(EPISODE, [alwaysPass()], ASOF), { asof_ms: ASOF });
    bundle.add(END_ROW);
    bundle.add({ ...END_ROW, fact: "admission.decision", claim: "admitted" });
    const sealed = bundle.seal();
    assert.deepEqual(sealed.unbound, []);
    assert.deepEqual(sealed.observations.map((o) => o.fact).sort(), ["admission.decision", "end.episode"]);
  });

  it("reads an attempt's client evidence from its client session's watermark, cs:<attempt>", () => {
    /** @type {Declaration} */
    const attempt = { kind: "attempt", id: "a2000000-0000-4000-8000-000000000002", tenant: TENANT, window: { from_ms: 0, to_ms: 100_000 } };
    /** @type {CheckDef} */
    const def = { ...alwaysPass(), code: "entry.always_pass", item: "attempt", requires: [{ fact: "end.client_screen", from: ["client"], query: "q" }] };
    const bundle = openBundle(profileFor(attempt, [def], ASOF), { asof_ms: ASOF });
    bundle.add({ ...END_ROW, fact: "end.client_screen", source: "client", origin: origin.measured("client"), subject: { attempt: attempt.id, tenant: TENANT }, claim: "join_failed" });
    bundle.watermark({ ...complete("client", ["end.client_screen"]), subject: `cs:${attempt.id}` });
    const verdict = judge(bundle.seal(), [def], { rules: rulesVersion([def], []), prior: null });
    assert.equal(verdict.coverage.state, "complete");
    assert.throws(() => {
      const other = openBundle(profileFor(attempt, [def], ASOF), { asof_ms: ASOF });
      other.watermark({ ...complete("client", ["end.client_screen"]), subject: "cs:a2000000-0000-4000-8000-0000000000ff" });
      other.seal();
    }, /names another attempt/u);
  });
});
