// @ts-check
/**
 * db.pool_saturated: every API pool connection is busy and acquires queue or
 * are canceled. A sample qualifies when total_conns equals max_conns and either
 * the empty-acquire delta averaged at least 100 ms of wait or at least one
 * acquire was canceled. Four consecutive qualifying samples are the finding;
 * the poller's own connection means the full pool cannot hide its witness.
 */
import { cite, largestHole, num, present, sampleRuns, str } from "./platform-lib.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "db.pool_saturated";
export const expected = "the API pool keeps spare connections, so acquires never queue long enough to wait 100 ms or be canceled";

const SAMPLE_GAP_MS = 90_000;
const QUALIFYING_WAIT_MS = 100;
const QUALIFYING_RUN = 4;

/** @param {unknown} declaration @param {unknown} seat */
export const applies = (declaration, seat) => declaration?.kind === "platform";

/** One sample counts when the pool was full and someone actually queued for it. @param {any} o */
const qualifying = (o) =>
  num(o, "total_conns") === num(o, "max_conns") &&
  num(o, "max_conns") > 0 &&
  ((num(o, "empty_acquire_count") >= 1 && num(o, "empty_acquire_wait_ms") / num(o, "empty_acquire_count") >= QUALIFYING_WAIT_MS) ||
    num(o, "canceled_acquire_count") >= 1);

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const pool = present(readings["db.pool"]);
  if (pool === null) return { status: "unknown", reason: "the pool health samples were not fully read" };
  const samples = pool.filter((o) => o.source === "api");
  if (samples.length === 0) return { status: "unknown", reason: "no db.health_sample witnessed the pool" };
  if (largestHole({ from_ms: window.from_ms, to_ms: window.to_ms }, samples) > SAMPLE_GAP_MS) {
    return { status: "unknown", reason: "db health samples missing over 90 s" };
  }

  const run = sampleRuns(samples)
    .flatMap((r) => consecutiveQualifying(r))
    .filter((r) => r.length >= QUALIFYING_RUN)
    .sort((a, b) => a[0].window.from_ms - b[0].window.from_ms)[0];
  if (!run) return { status: "pass" };

  const last = run[run.length - 1];
  const waited = run.filter((o) => num(o, "empty_acquire_count") >= 1);
  const canceled = run.reduce((sum, o) => sum + num(o, "canceled_acquire_count"), 0);
  const waitMS = waited.reduce((sum, o) => sum + num(o, "empty_acquire_wait_ms"), 0);
  const empty = waited.reduce((sum, o) => sum + num(o, "empty_acquire_count"), 0);
  const top = str(last, "stmt_top").split(";")[0]?.split(":")[0];
  const stmtStatus = str(last, "stmt_status");
  const facts = [
    cite(`${run.length} consecutive samples had the pool full (${num(last, "total_conns")}/${num(last, "max_conns")} connections) with acquires waiting`, run),
    cite(
      `acquires waited ${empty} times for an empty pool, ${waitMS} ms total${canceled ? `, and ${canceled} acquires were canceled` : ""}`,
      run.filter((o) => num(o, "empty_acquire_count") + num(o, "canceled_acquire_count") >= 1),
    ),
  ];
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: run[0].window.from_ms, to_ms: last.window.to_ms },
    hop: "db_pool",
    module: "api.postgres",
    reason: null,
    upstream: "witnessed",
    observed: `the API pool was exhausted for at least ${Math.round((last.window.from_ms - run[0].window.from_ms + 30_000) / 1000)} s while acquires queued`,
    facts,
    hypothesis:
      stmtStatus === "ok" && top
        ? {
            text: `${num(last, "idle_in_tx_backends")} idle-in-transaction sessions and top statement delta queryid ${top} held connections`,
            falsified_by: "pg_stat_activity showing the waiters were short transactions and the top delta was unrelated work",
          }
        : {
            text: `${num(last, "idle_in_tx_backends")} idle-in-transaction sessions held connections while new work queued`,
            falsified_by: "pg_stat_activity showing the waiters were short transactions, not held sessions",
          },
    falsify: { absence: null, attribution: "samples showing spare pool capacity inside the window" },
  };
}

/** Qualifying runs inside one contiguous seq run. @param {readonly any[]} run */
function consecutiveQualifying(run) {
  const out = [];
  let current = [];
  for (const o of run) {
    if (qualifying(o)) current.push(o);
    else if (current.length) {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}
