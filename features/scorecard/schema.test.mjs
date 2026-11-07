import assert from "node:assert/strict";
import test from "node:test";
import { SCORECARD_SCHEMA, parseScorecard, scorecardProblems } from "./schema.mjs";

const valid = () => ({
  schema: SCORECARD_SCHEMA,
  run: {
    id: "1762500000000-0b6c1f8e-3d2a-4c55-9a1e-2f4b6c8d0e1f",
    commit: "a".repeat(40),
    tier: "manual",
    environment: "staging",
    startedAt: "2026-11-07T10:20:30.000Z",
    client: { kind: "browser", browser: "chromium/151.0.7922.34", region: "do-sgp1", size: "s-4vcpu-8gb" },
  },
  mediaPlane: "chalk_sfu",
  metrics: [
    { id: "action.join.first_video_ms", unit: "ms", n: 20, p50: 410, p95: 620, source: "latency-kit" },
    { id: "action.leave_ms", unit: "ms", n: 0, p50: null, p95: null, source: "latency-kit" },
  ],
  dropped: [{ metric: "action.join.first_video_ms", reason: "wrong_media_plane", count: 2 }],
});

test("a v1 scorecard passes", () => {
  assert.deepEqual(scorecardProblems(valid()), []);
  assert.equal(parseScorecard(valid()).mediaPlane, "chalk_sfu");
});

test("unknown or repeated ids, a unit other than the registry's, and impossible percentiles fail", () => {
  const card = valid();
  card.metrics.push({ id: "action.join.first_video_ms", unit: "ms", n: 3, p50: 9, p95: 5, source: "latency-kit" }, { id: "action.joined_ms", unit: "ms", n: 1, p50: 1, p95: 1, source: "latency-kit" });
  card.metrics[1].unit = "count";
  assert.deepEqual(scorecardProblems(card), ["action.leave_ms: unit must be ms", "metrics: action.join.first_video_ms appears twice", "action.join.first_video_ms: p50 is above p95", "metrics: unknown id action.joined_ms"]);
});

test("hosts, IPs, URLs and resource ids are refused anywhere but the run id", () => {
  for (const leak of ["10.0.0.4", "fd00:1:2:3:4::5", "https://example", "sfu.example.com", "3d474782-c768-4dba-91f4-0123456789ab"]) {
    const card = valid();
    card.dropped[0].reason = "timeout";
    card.run.client.region = leak;
    const problems = scorecardProblems(card);
    assert.ok(problems.some((problem) => problem.startsWith("run.client.region looks like")), `${leak}: ${problems.join("; ")}`);
  }
});

test("free-text drop reasons and a missing environment fail", () => {
  const card = valid();
  card.dropped[0].reason = "Guest 1 got media on cloudflare_sfu";
  delete card.run.environment;
  assert.throws(() => parseScorecard(card), /run\.environment must be one of[\s\S]*reason must be a snake_case code/);
});
