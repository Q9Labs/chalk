// @ts-check
// fallow-ignore-file complexity -- each branch is a case of this test; the CRAP estimate reads a test's own branches as untested.
/**
 * Soundness tests over what a verdict keeps and adds. See soundness.test.mjs for the mutation relations.
 *
 * - retention: with the earlier verdict as prior, deleting rows silently (even every row) never erases a proven broken finding.
 * - copies: two rows copying one decision are one witness.
 * - backstops, rules held to their evidence, the catalogue check at load, and determinism.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CATALOGUE } from "./catalogue.mjs";
import { origin, watermark } from "./evidence.mjs";
import { rulesVersion } from "./verdict.mjs";
import { ASOF, IDS, nov18 } from "../fixtures/nov18.mjs";
import { verdictOf, base, notHealthy } from "./soundness.helpers.mjs";
/** @typedef {import("./profile.mjs").Declaration} Declaration */
/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */
/** @typedef {import("./verdict.mjs").Verdict} Verdict */
/** @typedef {{ observations: Observation[], watermarks: Watermark[] }} Evidence */

describe("retention: deleting evidence never erases a proven broken finding", () => {
  const { declaration, evidence } = base(IDS.ep9feb);
  const prior = verdictOf(declaration, evidence);
  const silent = /** @type {import("./verdict.mjs").Finding} */ (prior.findings.find((finding) => finding.code === "audio.not_heard"));

  it("keeps it after any single row is deleted silently", () => {
    for (const index of evidence.observations.keys()) {
      const changed = /** @type {Evidence} */ (structuredClone(evidence));
      changed.observations.splice(index, 1);
      const verdict = verdictOf(declaration, changed, { prior });
      assert.equal(verdict.outcome, "broken");
      assert.ok(verdict.findings.some((finding) => finding.id === silent.id));
    }
  });

  it("keeps it, with its proof copy, after every row is gone", () => {
    const verdict = verdictOf(declaration, { observations: [], watermarks: evidence.watermarks }, { prior });
    const kept = verdict.findings.find((finding) => finding.id === silent.id);
    assert.equal(verdict.outcome, "broken");
    assert.deepEqual(kept?.retained, { from_bundle: prior.bundle });
    assert.deepEqual(kept?.proof.observations, silent.proof.observations);
  });

  it("keeps it and lists a disagreement when a complete re-read now passes", () => {
    const changed = /** @type {Evidence} */ (structuredClone(evidence));
    const rollup = /** @type {Observation} */ (changed.observations.find((o) => o.id === IDS.evIngress));
    rollup.claim = "voiced";
    rollup.value = { packets: 10_480, voiced: 4_200 };
    const verdict = verdictOf(declaration, changed, { prior });
    assert.equal(verdict.outcome, "broken");
    assert.ok(verdict.disagreement.some((d) => d.kind === "finding" && d.finding === silent.id));
  });
});

describe("retention: deleting a report never erases its BLIND_SPOT", () => {
  it("keeps the BLIND_SPOT and its report entry after the report row is gone, so the recheck is not healthy", () => {
    const { declaration, evidence } = base(IDS.ep5c0d);
    const at = declaration.window.from_ms + 60_000;
    /** @type {Observation} */
    const report = {
      id: "e3000000-0000-4000-8000-0000000000f1",
      fact: "report.problem",
      source: "report",
      origin: origin.measured("report"),
      subject: { tenant: declaration.tenant, episode: declaration.id },
      window: { from_ms: at, to_ms: at },
      claim: "audio",
      value: { text: "could not hear the other person" },
      failure: false,
      query: "q",
    };
    const prior = verdictOf(declaration, { ...evidence, observations: [...evidence.observations, report] });
    assert.deepEqual(
      prior.findings.map((finding) => finding.backstop),
      ["BLIND_SPOT"],
    );

    const verdict = verdictOf(declaration, evidence, { prior });
    notHealthy(verdict, "the report row was deleted after its BLIND_SPOT was stored");
    assert.deepEqual(
      verdict.findings.map((finding) => finding.backstop),
      ["BLIND_SPOT"],
    );
    assert.deepEqual(
      verdict.reports.map((entry) => entry.evidence),
      [report.id],
    );
  });
});

describe("copies of one decision are one witness", () => {
  /** @type {CheckDef} */
  const twoWitnesses = {
    code: "end.recorded",
    item: "episode",
    per: "item",
    applies: () => true,
    requires: [{ fact: "end.episode", from: ["api", "sync"], independent: 2, query: "q" }],
    optional: [],
    expected: "two independent sources record the end",
    decide: ({ readings }) => (readings["end.episode"].kind === "present" ? { status: "pass" } : { status: "unknown", reason: "no end" }),
  };
  const catalogue = [twoWitnesses];
  const { declaration } = base(IDS.ep5c0d);
  const end = /** @type {number} */ (declaration.window.to_ms);
  /** @param {string} id @param {string} source @param {string} from */
  const row = (id, source, from) => ({ id, fact: "end.episode", source, origin: from, subject: { tenant: declaration.tenant ?? undefined, episode: declaration.id }, window: { from_ms: end, to_ms: end }, claim: "host_ended", value: {}, failure: false, query: "q" });
  const watermarks = ["api", "sync", "report"].map((source) => ({ source, subject: "*", complete_to_ms: ASOF, evidence_gaps: [], emits: ["end.episode", "report.problem"], build: source }));

  it("does not count an API decision and its Sync copy as two", () => {
    const verdict = verdictOf(declaration, { observations: [row("e1", "api", origin.decision("d1")), row("e2", "sync", origin.decision("d1"))], watermarks }, { catalogue });
    notHealthy(verdict, "a copied decision");
    const gap = verdict.coverage.gaps.find((entry) => entry.kind === "check");
    assert.ok(gap && gap.kind === "check" && gap.uncovered.some((entry) => entry.why === "independence"));
  });

  it("counts two origins as two", () => {
    const verdict = verdictOf(declaration, { observations: [row("e1", "api", origin.decision("d1")), row("e2", "sync", origin.measured("sync"))], watermarks }, { catalogue });
    assert.equal(verdict.outcome, "healthy");
  });

  it("marks a disagreement between copies of one decision as not independent", () => {
    const verdict = verdictOf(declaration, { observations: [row("e1", "api", origin.decision("d1")), { ...row("e2", "sync", origin.decision("d1")), claim: "time_limit" }], watermarks }, { catalogue });
    const entry = verdict.disagreement.find((d) => d.kind === "witness");
    assert.equal(entry?.kind === "witness" && entry.independent, false);
  });
});

describe("backstops and the empty profile", () => {
  it("calls a failure no rule claims UNEXPLAINED and broken", () => {
    const { declaration, evidence } = base(IDS.ep5c0d);
    const seat = declaration.kind === "episode" ? declaration.seats[0] : null;
    evidence.observations.push({
      id: "u1",
      fact: "join.leave",
      source: "client",
      origin: origin.measured("client"),
      subject: { tenant: declaration.tenant ?? undefined, episode: declaration.id, participant: seat?.participant },
      window: { from_ms: declaration.window.from_ms + 600_000, to_ms: declaration.window.from_ms + 600_000 },
      claim: "failed",
      value: {},
      failure: true,
      query: "q",
    });
    const verdict = verdictOf(declaration, evidence);
    assert.equal(verdict.outcome, "broken");
    assert.equal(verdict.findings[0]?.backstop, "UNEXPLAINED");
  });

  it("calls a report no earlier finding explains a BLIND_SPOT, which is unknown, not healthy", () => {
    const world = nov18();
    const declaration = /** @type {Declaration} */ (world.declarations.find((candidate) => candidate.id === IDS.ep31aa));
    const verdict = verdictOf(declaration, /** @type {Evidence} */ (world.evidence[IDS.ep31aa]));
    assert.equal(verdict.outcome, "unknown");
    assert.equal(verdict.findings[0]?.backstop, "BLIND_SPOT");
    assert.equal(verdict.reports[0]?.explained_by, null);
  });

  it("never calls an item with no applicable check healthy", () => {
    const { declaration, evidence } = base(IDS.ep5c0d);
    const bare = /** @type {Declaration} */ ({ ...declaration, features: [], seats: [] });
    const verdict = verdictOf(bare, { observations: [], watermarks: evidence.watermarks });
    assert.equal(verdict.outcome, "unknown");
    assert.ok(verdict.coverage.gaps.some((gap) => gap.kind === "empty"));
  });

  it("proves board absence only when the build can emit board evidence", () => {
    const { declaration, evidence } = base(IDS.ep9feb);
    for (const w of evidence.watermarks) if (w.source === "client") w.emits = [...w.emits, "board.camera"];
    const verdict = verdictOf(declaration, evidence);
    assert.deepEqual(verdict.coverage.by_code["board.view_jumped"], { checked: 4, eligible: 4 });
  });
});

describe("rules are held to their evidence", () => {
  const { declaration, evidence } = base(IDS.ep5c0d);
  /** @param {CheckDef["decide"]} decide @returns {CheckDef[]} */
  const one = (decide) => [{ code: "x.test", item: "episode", per: "item", applies: () => true, requires: [{ fact: "end.episode", from: ["api"], query: "q" }], optional: [], expected: "x", decide }];
  const finding = /** @type {const} */ ({ status: "finding", outcome: "broken", window: { from_ms: 0, to_ms: 0 }, hop: null, module: "unknown", reason: null, upstream: null, observed: "x", hypothesis: null, falsify: { absence: null, attribution: null } });

  it("rejects a fact that cites a row the check did not read", () => {
    assert.throws(() => verdictOf(declaration, evidence, { catalogue: one(() => ({ ...finding, facts: [{ text: "t", evidence: [evidence.observations[0].id], window: null, absent: null }] })) }), /not a present, citable observation/u);
  });

  it("rejects an absence its reading does not prove", () => {
    const unread = { observations: evidence.observations, watermarks: evidence.watermarks.filter((w) => w.source !== "api") };
    assert.throws(() => verdictOf(declaration, unread, { catalogue: one(() => ({ ...finding, facts: [{ text: "t", evidence: [], window: null, absent: "end.episode" }] })) }), /does not prove it/u);
  });

  it("rejects an absence over time the check never read", () => {
    // Sync's end row sits at the Episode's end, so the first second of the window is complete and holds no end.episode.
    /** @param {number} shift @returns {CheckDef[]} */
    const claim = (shift) => [
      {
        ...one(() => ({ status: "pass" }))[0],
        requires: [{ fact: "end.episode", from: ["sync"], query: "q" }],
        decide: ({ window }) => ({ ...finding, facts: [{ text: "t", evidence: [], window: { from_ms: window.from_ms + shift, to_ms: window.from_ms + 1000 + shift }, absent: "end.episode" }] }),
      },
    ];
    assert.doesNotThrow(() => verdictOf(declaration, evidence, { catalogue: claim(0) }));
    assert.throws(() => verdictOf(declaration, evidence, { catalogue: claim(-86_400_000) }), /does not prove it/u);
  });

  it("rejects a fact with neither evidence nor a proven absence", () => {
    assert.throws(() => verdictOf(declaration, evidence, { catalogue: one(() => ({ ...finding, facts: [{ text: "t", evidence: [], window: null, absent: null }] })) }), /cites no evidence/u);
  });

  it("rejects a decision the kernel does not define instead of reading it as a pass", () => {
    const fact = { text: "t", evidence: [evidence.observations.find((o) => o.fact === "end.episode")?.id ?? ""], window: null, absent: null };
    /** @type {[string, () => unknown, RegExp][]} */
    const cases = [
      ["a misspelt status", () => ({ status: "fail" }), /status "fail"/u],
      ["no decision", () => undefined, /status undefined/u],
      ["an outcome outside the vocabulary", () => ({ ...finding, outcome: "bad", facts: [fact] }), /outcome is broken, degraded, expected/u],
      ["a hypothesis with no witnessed upstream", () => ({ ...finding, upstream: "unknown", hypothesis: { text: "h", falsified_by: "f" }, facts: [fact] }), /witnessed upstream/u],
      ["a rule that throws", () => evidence.observations[999].fact, /check x\.test@\*: decide threw/u],
    ];
    for (const [name, decide, pattern] of cases) assert.throws(() => verdictOf(declaration, evidence, { catalogue: one(/** @type {CheckDef["decide"]} */ (decide)) }), pattern, name);
  });
});

describe("the catalogue is checked when it loads", () => {
  /** @param {Partial<CheckDef>} change @returns {CheckDef[]} */
  const one = (change) => [{ code: "x.test", item: "episode", per: "item", applies: () => true, requires: [{ fact: "end.episode", from: ["api"], query: "where episode_id == '{episode}'" }], optional: [], expected: "x", decide: () => ({ status: "pass" }), ...change }];
  /** @type {[string, Partial<CheckDef>, RegExp][]} */
  const cases = [
    ["a code with no area", { code: "nofr" }, /<area>\.<symptom>/u],
    ["a per-seat check on an attempt", { item: "attempt", per: "seat" }, /per-seat checks apply to Episodes only/u],
    ["no required fact", { requires: [] }, /at least one fact/u],
    ["an unknown fact", { requires: [{ fact: "video.frames", from: ["sfu"], query: "q" }] }, /declare it under an area.s facts/u],
    ["an unknown source", { requires: [{ fact: "end.episode", from: ["sfuu"], query: "q" }] }, /source "sfuu"/u],
    ["a misspelt placeholder", { requires: [{ fact: "end.episode", from: ["api"], query: "{particpant}" }] }, /\{particpant\}; placeholders are/u],
    ["a placeholder the check cannot fill", { requires: [{ fact: "end.episode", from: ["api"], query: "{participant}" }] }, /per-item episode check cannot fill/u],
  ];
  for (const [name, change, pattern] of cases) it(`rejects ${name}`, () => assert.throws(() => rulesVersion(one(change), []), pattern));

  it("changes the rules version when a module a rule reads changes, not only the rule's own source", () => {
    assert.notEqual(rulesVersion(CATALOGUE, ["const VOICE_DBFS = -50;"]), rulesVersion(CATALOGUE, ["const VOICE_DBFS = -10;"]));
  });

  it("refuses a client watermark for the whole item, because one seat's stream says nothing about another's", () => {
    assert.throws(() => watermark({ source: "client", subject: "*", complete_to_ms: 0, emits: [], evidence_gaps: [], build: "client 3.1.0" }), /per seat/u);
  });
});

describe("determinism", () => {
  it("gives the same verdict whatever order the rows arrive in", () => {
    const { declaration, evidence } = base(IDS.ep9feb);
    const forward = verdictOf(declaration, evidence);
    const backward = verdictOf(declaration, { observations: [...evidence.observations].reverse(), watermarks: [...evidence.watermarks].reverse() });
    assert.deepEqual(backward, forward);
  });
});
