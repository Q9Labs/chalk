// @ts-check
// fallow-ignore-file complexity -- each branch is a case of this test; the CRAP estimate reads a test's own branches as untested.
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
 *
 * Retention against a prior verdict, copies as one witness, the backstops and determinism are in soundness-backstops.test.mjs.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { standing } from "./check.mjs";
import { factDef, factKind } from "./facts.mjs";
import { IDS } from "../fixtures/nov18.mjs";
import { verdictOf, base, requiredWatermarks, HEALTHY, BASES, watermarkFor, notHealthy } from "./soundness.helpers.mjs";

/** @typedef {import("./profile.mjs").Declaration} Declaration */
/** @typedef {import("./profile.mjs").CheckDef} CheckDef */
/** @typedef {import("./evidence.mjs").Observation} Observation */
/** @typedef {import("./evidence.mjs").Watermark} Watermark */
/** @typedef {import("./verdict.mjs").Verdict} Verdict */
/** @typedef {{ observations: Observation[], watermarks: Watermark[] }} Evidence */

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
    const silent = verdict.findings.find((finding) => finding.code === "audio.not_heard");
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
      const read = requiredWatermarks(declaration);
      assert.ok(read.size > 0, `${id.slice(0, 4)} plans no check that reads a source`);
      for (const [index, w] of evidence.watermarks.entries()) {
        if (!read.has(`${w.source}/${w.subject}`)) continue;
        const changed = /** @type {Evidence} */ (structuredClone(evidence));
        changed.watermarks.splice(index, 1);
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
