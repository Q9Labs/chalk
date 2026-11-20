// @ts-check
/**
 * Metamorphic soundness tests. Each relation takes a world the kernel judges, changes one witness the way production loses or
 * corrupts evidence, and asserts what the verdict may no longer claim. They run every single mutation over every observation and
 * watermark of the base items, so a new check or fact inherits them.
 *
 * - delete: a row is gone and its source says so (an evidence_gap over it). The verdict is never healthy.
 * - lose a source: a watermark is gone. Never healthy.
 * - age: a source read only part of the window, or not at all, or has an open-ended gap. Never healthy.
 * - swap identity: a row names another Participant, generation, Episode or connection than the authority declared. Never healthy.
 * - contradict: a second witness claims something else about the same fact. Never healthy, and the disagreement is listed.
 * - retention: with the earlier verdict as prior, deleting rows silently (even every row) never erases a proven broken finding.
 * - copies: two rows copying one decision are one witness.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { openBundle } from "./bundle.mjs";
import { CATALOGUE, RULES } from "./catalogue.mjs";
import { standing } from "./check.mjs";
import { factDef, factKind } from "./facts.mjs";
import { origin, watermark } from "./evidence.mjs";
import { profileFor } from "./profile.mjs";
import { judge, rulesVersion } from "./verdict.mjs";
import { ASOF, IDS, nov18 } from "../fixtures/nov18.mjs";

/** @typedef {import("./profile.mjs").Declaration} Declaration */
/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */
/** @typedef {import("./verdict.mjs").Verdict} Verdict */
/** @typedef {{ observations: Observation[], watermarks: Watermark[] }} Evidence */

/**
 * @param {Declaration} declaration
 * @param {Evidence} evidence
 * @param {{ prior?: Verdict | null, catalogue?: readonly CheckDef[], asof?: number }} [options]
 */
function verdictOf(declaration, evidence, { prior = null, catalogue = CATALOGUE, asof = ASOF } = {}) {
  const bundle = openBundle(profileFor(declaration, catalogue, asof), { asof_ms: asof });
  for (const o of evidence.observations) bundle.add(o);
  for (const w of evidence.watermarks) bundle.watermark(w);
  return judge(bundle.seal(), catalogue, { rules: catalogue === CATALOGUE ? RULES : rulesVersion(catalogue, []), prior });
}

/** @param {string} id */
function base(id) {
  const world = nov18();
  const declaration = /** @type {Declaration} */ (world.declarations.find((candidate) => candidate.id === id));
  return { declaration, evidence: /** @type {Evidence} */ (structuredClone(world.evidence[id])) };
}

const HEALTHY = [IDS.ep5c0d, IDS.ep7a21];
const BASES = [...HEALTHY, IDS.ep9feb, IDS.ep2d4e, IDS.attempt, IDS.job];

/** The watermark that proves an observation's source for its subject. @param {Evidence} evidence @param {Observation} o */
function watermarkFor(evidence, o) {
  const seat = o.subject.participant ? `pt:${o.subject.participant}` : null;
  return evidence.watermarks.find((w) => w.source === o.source && (w.subject === seat || w.subject === "*"));
}

/** @param {Verdict} verdict @param {string} why */
function notHealthy(verdict, why) {
  assert.notEqual(verdict.outcome, "healthy", `${why}: the verdict must not be healthy`);
}

describe("baseline", () => {
  it("judges the healthy items healthy, so the relations below start from healthy", () => {
    for (const id of HEALTHY) {
      const { declaration, evidence } = base(id);
      const verdict = verdictOf(declaration, evidence);
      assert.equal(verdict.outcome, "healthy", id);
      assert.equal(verdict.coverage.state, "complete");
      assert.equal(verdict.coverage.checked, verdict.coverage.eligible);
    }
  });

  it("judges ep_9feb broken with board evidence unknown, never 'board unused'", () => {
    const { declaration, evidence } = base(IDS.ep9feb);
    const verdict = verdictOf(declaration, evidence);
    assert.equal(verdict.outcome, "broken");
    assert.equal(verdict.coverage.state, "partial");
    assert.deepEqual(verdict.coverage.by_code["board.view_jumped"], { checked: 0, eligible: 4 });
    const silent = verdict.findings.find((finding) => finding.code === "audio.no_voice_detected");
    assert.equal(silent?.hop, "sfu_ingress");
    assert.equal(silent?.upstream, "unknown");
    assert.equal(silent?.hypothesis, null, "zero voiced packets alone must not become a cause");
    assert.equal(verdict.findings.find((finding) => finding.code === "end.time_limit")?.outcome, "expected");
    assert.equal(verdict.findings.filter((finding) => finding.backstop === "UNEXPLAINED").length, 0, "the time-limit end claims Zara's failed leave");
    assert.equal(verdict.reports[0].explained_by, silent?.id);
  });
});

describe("delete: a row lost with its source saying so", () => {
  for (const id of BASES) {
    it(`never leaves ${id.slice(0, 4)} healthy`, () => {
      const { declaration, evidence } = base(id);
      for (const [index, o] of evidence.observations.entries()) {
        const changed = /** @type {Evidence} */ (structuredClone(evidence));
        changed.observations.splice(index, 1);
        const w = watermarkFor(changed, o);
        if (w) w.evidence_gaps = [...w.evidence_gaps, { from_ms: o.window.from_ms, to_ms: o.window.to_ms + 1, reason: "retention" }];
        notHealthy(verdictOf(declaration, changed), `deleting ${o.fact} ${o.id}`);
      }
    });
  }

  it("revokes healthy when a report is lost to a gap, because BLIND_SPOT needs the report stream", () => {
    const { declaration, evidence } = base(IDS.ep5c0d);
    const reports = /** @type {Watermark} */ (evidence.watermarks.find((w) => w.source === "report"));
    reports.evidence_gaps = [{ from_ms: declaration.window.from_ms + 60_000, to_ms: null, reason: "ingest stalled" }];
    const verdict = verdictOf(declaration, evidence);
    assert.equal(verdict.outcome, "unknown");
    assert.ok(verdict.coverage.gaps.some((gap) => gap.kind === "check" && gap.code === "BLIND_SPOT"));
  });
});

describe("lose a source", () => {
  for (const id of BASES) {
    it(`never leaves ${id.slice(0, 4)} healthy`, () => {
      const { declaration, evidence } = base(id);
      for (const [index, w] of evidence.watermarks.entries()) {
        const changed = /** @type {Evidence} */ (structuredClone(evidence));
        changed.watermarks.splice(index, 1);
        if (w.source === "api" && declaration.kind === "episode" && !declaration.features.includes("time_limit")) continue;
        notHealthy(verdictOf(declaration, changed), `dropping ${w.source}/${w.subject}`);
      }
    });
  }
});

describe("age: a source read only part of the window", () => {
  for (const id of HEALTHY) {
    it(`never leaves ${id.slice(0, 4)} healthy`, () => {
      const { declaration, evidence } = base(id);
      const end = /** @type {number} */ (declaration.window.to_ms);
      for (const index of evidence.watermarks.keys()) {
        if (evidence.watermarks[index].source === "api") continue;
        for (const age of /** @type {const} */ (["behind", "unread", "open_gap"])) {
          const changed = /** @type {Evidence} */ (structuredClone(evidence));
          const w = changed.watermarks[index];
          if (age === "behind") w.complete_to_ms = end - 60_000;
          if (age === "unread") w.complete_to_ms = null;
          if (age === "open_gap") w.evidence_gaps = [{ from_ms: end - 120_000, to_ms: null, reason: "client vanished" }];
          notHealthy(verdictOf(declaration, changed), `${age} ${w.source}/${w.subject}`);
        }
      }
    });
  }

  it("never reads a stale or unchecked verdict as healthy", () => {
    const { declaration, evidence } = base(IDS.ep5c0d);
    const verdict = verdictOf(declaration, evidence);
    const stored = { item: { kind: declaration.kind, id: declaration.id }, declaration: "x", fingerprint: "x", verdict };
    assert.equal(standing({ state: "stale", stored, why: "evidence" }).outcome, "unknown");
    assert.equal(standing({ state: "stale", stored, why: "rules" }).outcome, "unknown");
    assert.equal(standing({ state: "unchecked" }).outcome, "unknown");
    assert.equal(standing({ state: "current", stored }).outcome, "healthy");
  });

  it("keeps an open Episode unknown even when every witness looks fine", () => {
    const { declaration, evidence } = base(IDS.ep5c0d);
    const open = /** @type {Declaration} */ ({ ...declaration, window: { from_ms: declaration.window.from_ms, to_ms: null } });
    const verdict = verdictOf(open, evidence);
    assert.equal(verdict.outcome, "unknown");
    assert.ok(verdict.coverage.gaps.some((gap) => gap.kind === "open"));
  });
});

describe("swap identity", () => {
  for (const id of HEALTHY) {
    it(`never leaves ${id.slice(0, 4)} healthy`, () => {
      const { declaration, evidence } = base(id);
      if (declaration.kind !== "episode") throw new TypeError("healthy bases are Episodes");
      for (const index of evidence.observations.keys()) {
        const o = evidence.observations[index];
        const other = declaration.seats.find((seat) => seat.participant !== o.subject.participant)?.participant;
        /** @type {[string, (subject: Observation["subject"]) => Observation["subject"]][]} */
        const swaps = [
          ["another Episode", (subject) => ({ ...subject, episode: IDS.ep9feb })],
          ["an undeclared Participant", (subject) => ({ ...subject, participant: "f".repeat(32) })],
          ["another declared seat on the same connection", (subject) => ({ ...subject, participant: other })],
          ["a generation the seat never had", (subject) => ({ ...subject, generation: 7 })],
          ["another seat's connection", (subject) => ({ ...subject, connection: "mc-elsewhere" })],
          ["no seat at all", ({ participant: _participant, connection: _connection, generation: _generation, ...rest }) => rest],
        ];
        for (const [name, swap] of swaps) {
          if (name !== "another Episode" && o.subject.participant === undefined) continue;
          if (name === "no seat at all" && factDef(o.fact).per !== "seat") continue;
          const changed = /** @type {Evidence} */ (structuredClone(evidence));
          changed.observations[index] = { ...o, subject: swap(o.subject) };
          const verdict = verdictOf(declaration, changed);
          notHealthy(verdict, `${o.fact} ${o.id} names ${name}`);
          assert.ok(
            verdict.coverage.gaps.some((gap) => gap.kind === "unbound" && gap.evidence === o.id),
            `${name}: the row is unbound`,
          );
        }
      }
    });
  }

  it("treats two different rows with one event id as unbound, not as either", () => {
    const { declaration, evidence } = base(IDS.ep5c0d);
    evidence.observations.push({ ...evidence.observations[0], claim: "muted" });
    const verdict = verdictOf(declaration, evidence);
    notHealthy(verdict, "duplicate event id");
    assert.ok(verdict.coverage.gaps.some((gap) => gap.kind === "unbound" && gap.why.includes("share this event id")));
  });
});

describe("contradict", () => {
  /** @param {Observation} o */
  const flipped = (o) => ({ "audio.mic_state": o.claim === "unmuted" ? "muted" : "unmuted", "audio.ingress": o.claim === "voiced" ? "silent" : "voiced" })[o.fact] ?? `not_${o.claim}`;
  for (const id of [...HEALTHY, IDS.ep9feb]) {
    it(`never leaves ${id.slice(0, 4)} healthy and lists the disagreement`, () => {
      const { declaration, evidence } = base(id);
      for (const o of evidence.observations) {
        if (factKind(o.fact) === "event") continue;
        for (const copy of /** @type {const} */ (["independent", "same origin"])) {
          const changed = /** @type {Evidence} */ (structuredClone(evidence));
          changed.observations.push({ ...o, id: `${o.id.slice(0, -4)}ffff`, origin: copy === "independent" ? `${o.origin}:other` : o.origin, claim: flipped(o) });
          const verdict = verdictOf(declaration, changed);
          notHealthy(verdict, `contradicting ${o.fact} ${o.id} (${copy})`);
          const entry = verdict.disagreement.find((d) => d.kind === "witness" && d.fact === o.fact);
          assert.ok(entry && entry.kind === "witness", `contradicting ${o.fact}: a witness disagreement is listed`);
          assert.equal(entry.independent, copy === "independent");
        }
      }
    });
  }

  it("compares aggregates only over identical windows, so two rollups of different spans never disagree", () => {
    const { declaration, evidence } = base(IDS.ep5c0d);
    const rollup = /** @type {Observation} */ (evidence.observations.find((o) => o.fact === "audio.ingress"));
    evidence.observations.push({ ...rollup, id: `${rollup.id.slice(0, -4)}eeee`, window: { from_ms: rollup.window.from_ms, to_ms: rollup.window.from_ms + 60_000 }, claim: "silent", value: { packets: 10, voiced: 0 } });
    const verdict = verdictOf(declaration, evidence);
    assert.equal(verdict.disagreement.length, 0);
  });
});

describe("retention: deleting evidence never erases a proven broken finding", () => {
  const { declaration, evidence } = base(IDS.ep9feb);
  const prior = verdictOf(declaration, evidence);
  const silent = /** @type {import("./verdict.mjs").Finding} */ (prior.findings.find((finding) => finding.code === "audio.no_voice_detected"));

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

describe("copies of one decision are one witness", () => {
  /** @type {CheckDef} */
  const twoWitnesses = {
    code: "end.recorded",
    item: "episode",
    per: "item",
    applies: () => true,
    requires: [{ fact: "episode.end", from: ["api", "sync"], independent: 2, query: "q" }],
    optional: [],
    expected: "two independent sources record the end",
    decide: ({ readings }) => (readings["episode.end"].kind === "present" ? { status: "pass" } : { status: "unknown", reason: "no end" }),
  };
  const catalogue = [twoWitnesses];
  const { declaration } = base(IDS.ep5c0d);
  const end = /** @type {number} */ (declaration.window.to_ms);
  /** @param {string} id @param {string} source @param {string} from */
  const row = (id, source, from) => ({ id, fact: "episode.end", source, origin: from, subject: { episode: declaration.id }, window: { from_ms: end, to_ms: end }, claim: "host_ended", value: {}, failure: false, query: "q" });
  const watermarks = ["api", "sync", "report"].map((source) => ({ source, subject: "*", complete_to_ms: ASOF, evidence_gaps: [], emits: ["episode.end", "report.problem"], build: source }));

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
      fact: "client.leave",
      source: "client",
      origin: origin.measured("client"),
      subject: { episode: declaration.id, participant: seat?.participant },
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
  const one = (decide) => [{ code: "x.test", item: "episode", per: "item", applies: () => true, requires: [{ fact: "episode.end", from: ["api"], query: "q" }], optional: [], expected: "x", decide }];
  const finding = /** @type {const} */ ({ status: "finding", outcome: "broken", window: { from_ms: 0, to_ms: 0 }, hop: null, upstream: null, observed: "x", hypothesis: null, falsify: { absence: null, attribution: null } });

  it("rejects a fact that cites a row the check did not read", () => {
    assert.throws(() => verdictOf(declaration, evidence, { catalogue: one(() => ({ ...finding, facts: [{ text: "t", evidence: [evidence.observations[0].id], window: null, absent: null }] })) }), /not a present, citable observation/u);
  });

  it("rejects an absence its reading does not prove", () => {
    const unread = { observations: evidence.observations, watermarks: evidence.watermarks.filter((w) => w.source !== "api") };
    assert.throws(() => verdictOf(declaration, unread, { catalogue: one(() => ({ ...finding, facts: [{ text: "t", evidence: [], window: null, absent: "episode.end" }] })) }), /does not prove it/u);
  });

  it("rejects a fact with neither evidence nor a proven absence", () => {
    assert.throws(() => verdictOf(declaration, evidence, { catalogue: one(() => ({ ...finding, facts: [{ text: "t", evidence: [], window: null, absent: null }] })) }), /cites no evidence/u);
  });

  it("rejects a decision the kernel does not define instead of reading it as a pass", () => {
    const fact = { text: "t", evidence: [evidence.observations.find((o) => o.fact === "episode.end")?.id ?? ""], window: null, absent: null };
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
  const one = (change) => [{ code: "x.test", item: "episode", per: "item", applies: () => true, requires: [{ fact: "episode.end", from: ["api"], query: "where episode_id == '{episode}'" }], optional: [], expected: "x", decide: () => ({ status: "pass" }), ...change }];
  /** @type {[string, Partial<CheckDef>, RegExp][]} */
  const cases = [
    ["a code with no area", { code: "nofr" }, /<area>\.<symptom>/u],
    ["a per-seat check on an attempt", { item: "attempt", per: "seat" }, /per-seat checks apply to Episodes only/u],
    ["no required fact", { requires: [] }, /at least one fact/u],
    ["an unknown fact", { requires: [{ fact: "video.frames", from: ["sfu"], query: "q" }] }, /add it to scripts\/diagnose-call\/proof\/facts\.mjs/u],
    ["an unknown source", { requires: [{ fact: "episode.end", from: ["sfuu"], query: "q" }] }, /source "sfuu"/u],
    ["a misspelt placeholder", { requires: [{ fact: "episode.end", from: ["api"], query: "{particpant}" }] }, /\{particpant\}; placeholders are/u],
    ["a placeholder the check cannot fill", { requires: [{ fact: "episode.end", from: ["api"], query: "{participant}" }] }, /per-item episode check cannot fill/u],
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
