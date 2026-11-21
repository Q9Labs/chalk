// @ts-check
/**
 * db.lock_wait: chalk-api backends wait on a lock another session holds. Two
 * consecutive samples with a Lock waiter at least 5 s old are the finding;
 * the blocker's application_name decides whether the API stalled itself
 * (api.postgres) or an outside session did (postgres.other_session), and a
 * blocker the role may not see is attributed the second way too.
 */
import { cite, largestHole, num, present, sampleRuns, str } from "./platform-lib.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "db.lock_wait";
export const expected = "no chalk-api backend waits on a lock for 5 s or longer";

const SAMPLE_GAP_MS = 90_000;
const MIN_WAIT_MS = 5000;

/** @param {unknown} declaration @param {unknown} seat */
export const applies = (declaration, seat) => declaration?.kind === "platform";

/** @param {any} o */
const waiting = (o) => num(o, "lock_waiters") >= 1 && num(o, "max_lock_wait_ms") >= MIN_WAIT_MS;

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const lock = present(readings["db.lock"]);
  if (lock === null) return { status: "unknown", reason: "the lock health samples were not fully read" };
  const samples = lock.filter((o) => o.source === "api");
  if (samples.length === 0) return { status: "unknown", reason: "no db.health_sample witnessed lock state" };
  if (samples.every((o) => str(o, "lock_status") === "failed")) return { status: "unknown", reason: "lock query failed" };
  if (largestHole({ from_ms: window.from_ms, to_ms: window.to_ms }, samples) > SAMPLE_GAP_MS) {
    return { status: "unknown", reason: "db health samples missing over 90 s" };
  }
  const readFailed = samples.some((o) => str(o, "lock_status") === "failed");
  const waitedAnywhere = samples.some((o) => num(o, "lock_waiters") >= 1);
  if (readFailed && waitedAnywhere) return { status: "unknown", reason: "lock query failed" };

  const runs = sampleRuns(samples)
    .flatMap((run) => waitingRuns(run))
    .filter((r) => r.length >= 2)
    .sort((a, b) => a[0].window.from_ms - b[0].window.from_ms);
  const run = runs[0];
  if (!run) return { status: "pass" };

  const last = run[run.length - 1];
  const blockerApp = str(last, "blocker_application_name");
  const module = blockerApp.startsWith("chalk-api") ? "api.postgres" : "postgres.other_session";
  const request = present(readings["release.request"]);
  const support = (request ?? []).filter((o) => o.window.to_ms > run[0].window.from_ms && o.window.from_ms < last.window.to_ms);
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: run[0].window.from_ms, to_ms: last.window.to_ms },
    hop: "db_lock",
    module,
    reason: null,
    upstream: "witnessed",
    observed: `chalk-api backends waited on a lock for at least ${Math.round(num(last, "max_lock_wait_ms") / 1000)} s`,
    facts: [
      cite(`${run.length} consecutive samples saw ${num(last, "lock_waiters")} lock waiter(s), oldest ${Math.round(num(last, "max_lock_wait_ms") / 1000)} s`, run),
      ...(support.length ? [cite(`${support.length} API request(s) answered slowly while the wait held`, support)] : []),
    ],
    hypothesis: blockerApp
      ? {
          text: `the blocker is ${blockerApp}${str(last, "blocker_usename") ? ` as ${str(last, "blocker_usename")}` : ""}, transaction ${Math.round(num(last, "blocker_xact_age_ms") / 1000)} s old`,
          falsified_by: "pg_stat_activity showing the waiter's lock is held by a different session",
        }
      : {
          text: "the blocking session is outside chalk-api or its identity is hidden from this role (unavailable(role_lacks_pg_read_all_stats))",
          falsified_by: "pg_stat_activity naming a chalk-api session as the blocker",
        },
    falsify: { absence: null, attribution: "samples showing the wait cleared inside the window" },
  };
}

/** Maximal runs of waiting samples inside one contiguous seq run. @param {readonly any[]} run */
function waitingRuns(run) {
  const out = [];
  let current = [];
  for (const o of run) {
    if (waiting(o)) current.push(o);
    else if (current.length) {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}
