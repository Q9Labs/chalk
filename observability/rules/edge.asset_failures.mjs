// @ts-check
/**
 * edge.asset_failures: the web origin can't serve its own assets — 404 plus
 * 5xx on path_class=asset at 10+ requests and 2% for two consecutive counted
 * buckets. Never expected: a stale tab losing a removed chunk is still a
 * broken page. A recent web marker decides which hypothesis the finding
 * carries, and that hypothesis is a witnessed upstream hop.
 */
import { bucketStarts, buckets, cite, FIVE_MIN, num, okTicks, present, requests, str } from "./platform-lib.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "edge.asset_failures";
export const expected = "the web origin serves every asset it deploys, so asset 404 and 5xx stay under 2%";

const MIN_REQUESTS = 10;
const MIN_SHARE = 0.02;
const RECENT_MARKER_MS = 2 * 3600_000;

/** @param {unknown} declaration @param {unknown} seat */
export const applies = (declaration, seat) => declaration?.kind === "platform";

/** @param {any} o */
const badAsset = (o) => {
  const status = num(o, "edge_status");
  return str(o, "path_class") === "asset" && (status === 404 || status >= 500);
};

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings }) {
  const rollups = present(readings["edge.bucket"]);
  const tickRows = present(readings["edge.tick"]);
  if (rollups === null || tickRows === null) return { status: "unknown", reason: "the edge rollups or collector ticks were not fully read" };
  const ticks = okTicks(tickRows);
  const markers = (present(readings["release.marker"]) ?? []).filter((o) => o.source === "release" && str(o, "component") === "web");

  const byHost = new Map();
  for (const o of rollups) {
    if (str(o, "path_class") !== "asset") continue;
    const host = str(o, "host");
    (byHost.get(host) ?? byHost.set(host, []).get(host)).push(o);
  }

  for (const [host, rows] of byHost) {
    const byBucket = buckets(rows, { health: true });
    const starts = bucketStarts(byBucket);
    for (const start of starts) {
      if (!ticks.has(`${host}|${start}`)) return { status: "unknown", reason: "edge bucket without an ok collector tick" };
    }
    for (let i = 0; i + 1 < starts.length; i++) {
      if (starts[i + 1] - starts[i] !== FIVE_MIN) continue;
      const pair = [starts[i], starts[i + 1]].map((start) => {
        const group = byBucket.get(start);
        return { host, start, group, total: requests(group), bad: requests(group, badAsset) };
      });
      if (!pair.every((b) => b.bad >= MIN_REQUESTS && b.bad / b.total >= MIN_SHARE)) continue;
      const [a, b] = pair;
      const recent = markers.some((m) => a.start - num(m, "finished_ms") >= 0 && a.start - num(m, "finished_ms") < RECENT_MARKER_MS);
      return {
        status: "finding",
        outcome: "broken",
        window: { from_ms: a.start, to_ms: b.start + FIVE_MIN },
        hop: "edge_asset",
        module: "web.pages",
        reason: null,
        upstream: "witnessed",
        observed: `${host} failed ${Math.max(a.bad, b.bad)} asset requests for two consecutive buckets`,
        facts: [
          cite(`two counted asset buckets at ${(Math.min(a.bad / a.total, b.bad / b.total) * 100).toFixed(1)}%+ 404/5xx`, [...a.group, ...b.group]),
          ...(recent ? [cite("a web marker finished under two hours before", markers.filter((m) => a.start - num(m, "finished_ms") < RECENT_MARKER_MS))] : []),
        ],
        hypothesis: recent
          ? { text: "stale tab requesting a removed chunk", falsified_by: "the failures coming from first boots of the new release" }
          : { text: "chunk missing from the deploy", falsified_by: "the same assets served inside the window" },
        falsify: { absence: null, attribution: "counted asset buckets with 404/5xx under 2% inside the window" },
      };
    }
  }
  return { status: "pass" };
}
