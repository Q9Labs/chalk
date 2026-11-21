import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseRows, strictCode } from "./index.mjs";
import { normalizeRow } from "./rows.mjs";
import { EPISODE } from "./scenarios.mjs";
import { recoveredDropCall } from "./scenarios-sfu.mjs";

const diagnose = (rows, gaps = []) =>
  diagnoseRows(
    EPISODE,
    rows.map((row) => normalizeRow(row)),
    gaps,
  );
const kind = (result, name) => result.findings.find((finding) => finding.kind === name);

test("a drop the connection recovered from on its own is a recovered drop with its length, and it does not fail the call", () => {
  const result = diagnose(recoveredDropCall());
  const drop = kind(result, "recovered_drop");
  assert.ok(drop.benign);
  assert.match(drop.experience, /lost its media path for 10 s at 10:01:30 UTC and recovered without rejoining/u);
  assert.equal(strictCode(result), 0);
  assert.match(result.verdict, /recovered on its own/u);
});
