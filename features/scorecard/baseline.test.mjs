import assert from "node:assert/strict";
import { test } from "node:test";
import { withoutRetiredMetrics } from "./baseline.mjs";
import { WHOLE_CYCLE } from "./schema.mjs";

test("a baseline keeps the metrics that exist today and forgets the retired ones", () => {
  const kept = { id: "action.leave_ms", unit: "ms", n: 20, p50: 1, p95: 1, source: "latency-kit" };
  const card = {
    metrics: [kept, { ...kept, id: "sfu.retired.example" }],
    dropped: [
      { metric: WHOLE_CYCLE, reason: "x" },
      { metric: "sfu.retired.example", reason: "x" },
    ],
  };
  const result = withoutRetiredMetrics(card);
  assert.deepEqual(result.metrics, [kept]);
  assert.deepEqual(result.dropped, [card.dropped[0]]);
});
