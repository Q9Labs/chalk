import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseRows, strictCode } from "./index.mjs";
import { render } from "./render.mjs";
import { normalizeRow } from "./rows.mjs";
import { EPISODE, fixture } from "./scenarios.mjs";
import { unmuteCall, unmuteOverBudgetCall, unmuteWithinBudgetCall } from "./scenarios-sfu.mjs";
import { percentile } from "./unmute.mjs";

const diagnose = (rows) =>
  diagnoseRows(
    EPISODE,
    rows.map((row) => normalizeRow(row)),
  );

test("the p95 is the nearest rank: the largest of up to twenty values", () => {
  assert.equal(percentile([], 0.95), undefined);
  assert.equal(percentile([5, 1, 3], 0.95), 5);
  assert.equal(
    percentile(
      Array.from({ length: 100 }, (_, index) => index + 1),
      0.95,
    ),
    95,
  );
});

test("unmutes inside the budget report the node's legs against it and fail nothing", () => {
  const result = diagnose(unmuteWithinBudgetCall());
  assert.deepEqual(result.unmutes.p95, { heldToVoiced: 1100, voicedToForwarded: 150, heldToForwarded: 1250 });
  assert.equal(
    result.findings.some((finding) => finding.kind === "unmute_slow"),
    false,
  );
  const text = render({ ...result, elapsedMs: 0 });
  assert.match(text, /Unmute, the node's legs at p95 over 3 unmutes: held to first voiced 1100 ms \(3 unmutes\), first voiced to first forwarded 150 ms \(3 subscribers\), held to first forwarded 1250 ms \(3 subscribers\): within the 2250 ms budget/u);
  assert.match(text, /Mute: the node applied 1 mutes; the 1250 ms p95 budget/u);
  assert.equal(strictCode(result), 0);
});

test("an unmute whose node total is over the budget at p95 is a finding that names the leg that took the time", () => {
  const result = diagnose(unmuteOverBudgetCall());
  const slow = result.findings.find((finding) => finding.kind === "unmute_slow");
  assert.equal(result.unmutes.p95.heldToForwarded, 2700);
  assert.equal(slow.side, "SFU");
  assert.equal(slow.stage, "forwarding");
  assert.match(slow.cause, /forwarding leg took 1900 ms at p95/u);
  assert.match(slow.notes.join("\n"), /1 of 3 first-forwarded lines were over 2250 ms; the worst was 2700 ms/u);
  assert.match(render({ ...result, elapsedMs: 0 }), /over budget: Participant 153be25c microphone unmute 3 at 10:02:20 UTC took 2700 ms to reach Participant 3c7e85ea \(held to voiced 800 ms, voiced to forwarded 1900 ms\)/u);
  assert.equal(strictCode(result), 3);
});

test("when the time goes before the first voiced packet the finding says part of it is the speaker's", () => {
  const slow = diagnose(unmuteCall([[2400, 100]])).findings.find((finding) => finding.kind === "unmute_slow");
  assert.equal(slow.stage, "publishing");
  assert.match(slow.notes.join("\n"), /includes the time the speaker took to start speaking/u);
});

test("the client's legs are a named slot listed as missing data, and a subscriber that got no first-forwarded line is a gap", () => {
  const f = fixture();
  const rows = unmuteWithinBudgetCall().filter((row) => row.attributes?.event !== "sfu.unmute.first_forwarded");
  const text = diagnose([...rows, f.node(300, "sfu.session.closed", "viewer", "conn-view", { cause: "removed" })])
    .gaps.map((gap) => `${gap.blocks ? "blocks " : ""}${gap.what}`)
    .join("\n");
  assert.match(text, /no client rows carry the unmute legs \(click to the node's acknowledgement, receiver playout\)/u);
  assert.match(text, /3 subscribed connections got no sfu\.unmute\.first_forwarded line/u);
  assert.doesNotMatch(text, /blocks no client rows carry the unmute legs/u);
});
