// @ts-check
/**
 * db.unreachable: the API cannot open or ping Postgres. Two consecutive
 * db.health_sample samples with db_reach=down, or two consecutive
 * database-unreachable collector rows, prove it. When the collector says the
 * database was up in the same minute the fault is the API's own connection —
 * api.postgres — and the two claims are events of one fact, so the kernel
 * prints their contradiction as a disagree line.
 */
import { cite, largestHole, minuteRuns, num, present, qualifyingRuns, sampleRuns, str } from "./platform-lib.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "db.unreachable";
export const expected = "the API's health poller reaches Postgres on its own connection every 30 s, and the host collector's database-unreachable row stays 0";

const SAMPLE_GAP_MS = 90_000;
const COLLECTOR_GAP_MS = 3 * 60_000;

/** @param {unknown} declaration @param {unknown} seat */
export const applies = (declaration, seat) => declaration?.kind === "platform";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const reachable = present(readings["db.reachable"]);
  if (reachable === null) {
    return readings["db.reachable"].kind === "unknown"
      ? { status: "unknown", reason: "neither the health samples nor the host collector rows were fully read" }
      : { status: "unknown", reason: "no health sample and no collector row witnessed the database state" };
  }
  const samples = reachable.filter((o) => o.source === "api");
  const collector = reachable.filter((o) => o.source === "host");

  if (samples.length && largestHole({ from_ms: window.from_ms, to_ms: window.to_ms }, samples) > SAMPLE_GAP_MS) {
    return { status: "unknown", reason: "db health samples missing over 90 s" };
  }
  if (samples.length === 0 && collector.length === 0) {
    return { status: "unknown", reason: "no health sample and no collector row witnessed the database state" };
  }
  if (samples.length === 0 && largestHole({ from_ms: window.from_ms, to_ms: window.to_ms }, collector) > COLLECTOR_GAP_MS) {
    return { status: "unknown", reason: "host collector rows missing over 3 min" };
  }

  const down = (o) => str(o, "db_reach") === "down";
  const downSampleRuns = sampleRuns(samples).flatMap((r) => qualifyingRuns(r, down));
  const collectorRuns = minuteRuns(collector, down);
  const run = [...downSampleRuns, ...collectorRuns].filter((r) => r.length >= 2).sort((a, b) => a[0].window.from_ms - b[0].window.from_ms)[0];
  if (!run) return { status: "pass" };

  const first = run[0];
  const last = run[run.length - 1];
  const fromCollector = first.source === "host";
  // The collector's claim for the first down minute decides the module:
  // down with it -> postgres.server, up against it -> api.postgres, no row -> postgres.server.
  const minute = { from_ms: first.window.from_ms, to_ms: first.window.from_ms + 60_000 };
  const collectorRow = collector.find((o) => o.window.from_ms < minute.to_ms && minute.from_ms < o.window.to_ms);
  const apiSamplesDown = !fromCollector;
  const module = apiSamplesDown && collectorRow && !down(collectorRow) ? "api.postgres" : "postgres.server";
  const evidence = [...run];
  if (!fromCollector && collectorRow) evidence.push(collectorRow);
  const status = fromCollector ? "collector rows" : `samples (${[...new Set(run.map((o) => str(o, "db_status")))].join(", ")})`;
  return {
    status: "finding",
    outcome: "broken",
    window: { from_ms: first.window.from_ms, to_ms: Math.max(last.window.to_ms, first.window.to_ms + 30_000) },
    hop: "db_connect",
    module,
    reason: null,
    upstream: "witnessed",
    observed: `Postgres was unreachable from ${status} for ${Math.round((last.window.from_ms - first.window.from_ms + last.window.to_ms - last.window.from_ms) / 1000)} s`,
    facts: [
      cite(`${run.length} consecutive ${fromCollector ? "host collector rows" : "db.health_sample samples"} said the database is down`, run),
      ...(collectorRow ? [cite("the host collector saw the database in the same minute", [collectorRow])] : []),
    ],
    hypothesis:
      module === "postgres.server"
        ? { text: "Postgres is refusing or dropping connections for every client", falsified_by: "a collector row or a later sample showing the database reachable inside the window" }
        : { text: "the API's own connection or pool path to Postgres is failing while the host still reaches it", falsified_by: "the host collector reporting database-unreachable for the same minute" },
    falsify: {
      absence: null,
      attribution: "2 consecutive samples or collector rows showing the database up inside the window",
    },
  };
}
