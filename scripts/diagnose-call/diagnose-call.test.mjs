import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseRows } from "./index.mjs";
import { EPISODE, hashOf, neverConnectedCall, scenarios } from "./scenarios.mjs";
import { normalizeRow } from "./rows.mjs";

const normalized = (rows) => rows.map((row) => normalizeRow(row));
const diagnose = (rows, gaps = []) => diagnoseRows(EPISODE, normalized(rows), gaps);

test("a never_connected session is named with what the node saw, the side it cannot prove, and the rows that prove it", () => {
  const result = diagnose(neverConnectedCall());
  const finding = result.findings.find((candidate) => candidate.kind === "never_connected");
  assert.equal(finding.participant, hashOf.viewer);
  assert.equal(finding.stage, "connecting");
  assert.equal(finding.side, "unknown");
  assert.match(finding.cause, /ICE checking but never a connected path/u);
  assert.match(finding.cause, /do not say which end blocked it/u);
  assert.ok(finding.proof.ids.length >= 2 && finding.proof.ids.every((id) => /^fx-\d{4}$/u.test(id)));
  assert.match(result.verdict, /had no media path.*failing stage: connecting, side: unknown/u);
  assert.doesNotMatch(result.verdict, /No bad call/u);
});

test("an Episode no row reaches is not a good call, and a call with a missing source is not either", () => {
  const empty = diagnose([]);
  assert.match(empty.verdict, /^Not enough evidence: no row reached this Episode/u);
  const partial = diagnose(scenarios["missing sources"]());
  assert.match(partial.verdict, /^Not enough evidence.*Missing sources: API, SFU node, Sync, database\./u);
  assert.doesNotMatch(partial.verdict, /No bad call/u);
});

test("a call with every source and flowing media is a clean call, and a lease revoked as the Participant leaves is not a cause", () => {
  const result = diagnose(scenarios["clean call"]());
  assert.deepEqual(result.findings, []);
  assert.deepEqual(
    result.gaps.filter((gap) => gap.blocks),
    [],
  );
  assert.match(result.verdict, /^No bad call found by the rules in the rows of every source/u);
});
