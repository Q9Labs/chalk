// @ts-check
/**
 * edge.origin_unreachable: Cloudflare reached the edge but not the origin.
 * Rollups prove it when origin-failure statuses hold half of a host's
 * non-health traffic at 10+ requests for two consecutive counted buckets, and
 * the uptime probe proves it when two consecutive checks fail inside buckets
 * that saw the same statuses. The host's runtime-health row for that minute
 * then splits host.tunnel, api.process, host.node, cf.tunnel_route (as a
 * disagree line) and the http modules on the origin status.
 */
import { bucketStarts, buckets, cite, FIVE_MIN, num, okTicks, present, requests, str } from "./platform-lib.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "edge.origin_unreachable";
export const expected = "every host's origin answers the edge, so origin-failure statuses stay rare and the uptime probe stays up";

const ORIGIN_FAIL = new Set([502, 503, 504, 520, 521, 522, 523, 524, 525, 526, 530]);
const MIN_REQUESTS = 10;
const MIN_SHARE = 0.5;
const HOSTLESS_MODULES = new Set(["web", "nightly", "local"]);

/** @param {unknown} declaration @param {unknown} seat */
export const applies = (declaration, seat) => declaration?.kind === "platform";

/** The module the host minute attributes the failure to. @param {any} bucket @param {readonly any[]} hostRows @param {boolean} hostRowsStopped */
function attribute(bucket, hostRows, hostRowsStopped) {
  const origin = Math.max(...bucket.rows.filter((o) => num(o, "edge_status") >= 500).map((o) => num(o, "origin_status")));
  if (origin >= 500) {
    const host = str(bucket.rows[0], "host");
    return host.startsWith("api.") ? "api.http" : host.startsWith("sync.") ? "sync.http" : "web.pages";
  }
  const minute = hostRows.find((o) => o.window.from_ms <= bucket.start + FIVE_MIN && bucket.start < o.window.to_ms + FIVE_MIN);
  if (!minute) {
    const host = str(bucket.rows[0], "host");
    const prefix = host.split(".")[0];
    if (hostRowsStopped) return "host.node";
    if (HOSTLESS_MODULES.has(prefix) || !hostRows.length) return "host.origin";
    return "host.node";
  }
  const reason = str(minute, "chalk_alert_reason");
  const down = str(minute, "origin_reach") === "down" || num(minute, "chalk_alert_value") === 1;
  if (reason.includes("tunnel")) return "host.tunnel";
  if (reason === "api_unhealthy" || reason.includes("api_unhealthy")) return "api.process";
  if (down && !hostRowsStopped) return "host.node";
  if (!down) return "cf.tunnel_route";
  return "host.origin";
}

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, window }) {
  const rollups = present(readings["edge.bucket"]);
  const tickRows = present(readings["edge.tick"]);
  if (rollups === null || tickRows === null) return { status: "unknown", reason: "the edge rollups or collector ticks were not fully read" };
  const ticks = okTicks(tickRows);
  const uptimes = (present(readings["edge.origin_up"]) ?? []).filter((o) => o.source === "edge");
  const hostRows = (present(readings["edge.origin_up"]) ?? []).filter((o) => o.source === "host");
  const runtime = present(readings["edge.host_runtime"]) ?? [];

  const byHost = new Map();
  for (const o of rollups) {
    const host = str(o, "host");
    (byHost.get(host) ?? byHost.set(host, []).get(host)).push(o);
  }
  if (byHost.size === 0 && uptimes.length === 0) return { status: "pass" };

  // A counted bucket without an ok tick is a gap, never a zero.
  for (const [host, rows] of byHost) {
    for (const start of bucketStarts(buckets(rows))) {
      if (!ticks.has(`${host}|${start}`)) return { status: "unknown", reason: "edge bucket without an ok collector tick" };
    }
  }
  for (const host of byHost.keys()) {
    if ((host.startsWith("api.") || host.startsWith("sync.")) && hostRows.length === 0 && runtime.length === 0) {
      return { status: "unknown", reason: "no runtime-health row for the host" };
    }
  }

  /** Find two consecutive counted buckets where origin failures dominate. */
  const hotRuns = [];
  for (const [host, rows] of byHost) {
    const byBucket = buckets(rows);
    const starts = bucketStarts(byBucket);
    for (let i = 0; i + 1 < starts.length; i++) {
      if (starts[i + 1] - starts[i] !== FIVE_MIN) continue;
      const pair = [starts[i], starts[i + 1]].map((start) => {
        const group = byBucket.get(start);
        const total = requests(group);
        const bad = requests(group, (o) => ORIGIN_FAIL.has(num(o, "edge_status")));
        return { host, start, group, total, bad };
      });
      if (pair.every((b) => b.total >= MIN_REQUESTS && b.bad / b.total >= MIN_SHARE)) hotRuns.push(pair);
    }
  }
  const hot = hotRuns.sort((a, b) => a[0].start - b[0].start)[0];
  if (hot) {
    const [a, b] = hot;
    const host = a.host;
    const hostStopped = hostRows.length > 0 && !hostRows.some((o) => o.window.from_ms >= a.start);
    const minuteRows = [...hostRows, ...runtime];
    const bucket = { host, start: a.start, rows: [...a.group, ...b.group] };
    const module = attribute(bucket, minuteRows, hostStopped);
    const hostMinute = minuteRows.find((o) => o.window.from_ms <= a.start + FIVE_MIN && a.start < o.window.to_ms + FIVE_MIN) ?? null;
    const evidence = [...a.group, ...b.group, ...(hostMinute ? [hostMinute] : [])];
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: a.start, to_ms: b.start + FIVE_MIN },
      hop: "edge_origin",
      module,
      reason: null,
      upstream: "witnessed",
      observed: `${host}'s origin returned edge failures on at least half of ${Math.max(a.total, b.total)}+ requests for two consecutive buckets`,
      facts: [
        cite(`two counted buckets at ${Math.round((Math.min(a.bad / a.total, b.bad / b.total)) * 100)}%+ origin-failure share`, [...a.group, ...b.group]),
        ...(hostMinute ? [cite(`the host's runtime-health minute says ${str(hostMinute, "chalk_alert_reason") || str(hostMinute, "origin_reach")}`, [hostMinute])] : []),
      ],
      hypothesis: {
        "host.tunnel": { text: "the tunnel the host serves through is down", falsified_by: "a tunnel witness or a healthy runtime-health row inside the buckets" },
        "api.process": { text: "the API process was down or unready while the host kept running", falsified_by: "a runtime-health row showing the api healthy inside the buckets" },
        "host.node": { text: "the host stopped reporting while the edge kept reaching it", falsified_by: "runtime-health rows arriving inside the buckets" },
        "cf.tunnel_route": { text: "the Cloudflare route for the host points at a dead target while the host reports healthy", falsified_by: "the host's runtime-health row turning down inside the buckets" },
        "host.origin": { text: "the origin the edge targets is down and no host witness covers it", falsified_by: "any host-side row for that minute" },
        "api.http": { text: "the API answered the edge with 5xx", falsified_by: "api rows for that minute under 5xx share" },
        "sync.http": { text: "Sync answered the edge with 5xx", falsified_by: "sync rows for that minute under 5xx share" },
        "web.pages": { text: "the web origin answered with 5xx", falsified_by: "web rows for that minute under 5xx share" },
      }[module],
      falsify: { absence: null, attribution: "counted buckets with origin-failure share under half inside the window" },
    };
  }

  // Uptime probe path: two consecutive failed checks whose buckets saw the
  // same statuses on real traffic.
  const fails = uptimes.filter((o) => str(o, "origin_reach") === "down").sort((x, y) => x.window.from_ms - y.window.from_ms);
  for (let i = 0; i + 1 < fails.length; i++) {
    const [first, second] = [fails[i], fails[i + 1]];
    if (second.window.from_ms - first.window.from_ms > 2 * FIVE_MIN) continue;
    const target = str(first, "target");
    const host = byHost.has(target) ? target : [...byHost.keys()].find((h) => h === target || h.includes(target));
    if (!host) continue;
    const sawBad = [first, second].every((check) => {
      const start = Math.floor(check.window.from_ms / FIVE_MIN) * FIVE_MIN;
      const group = buckets(byHost.get(host) ?? []).get(start) ?? [];
      return requests(group, (o) => ORIGIN_FAIL.has(num(o, "edge_status"))) >= 1;
    });
    if (!sawBad) continue;
    const start0 = Math.floor(first.window.from_ms / FIVE_MIN) * FIVE_MIN;
    const minuteRows = [...hostRows, ...runtime];
    const hostStopped = hostRows.length > 0 && !hostRows.some((o) => o.window.from_ms >= start0);
    const module = attribute({ host, start: start0, rows: byHost.get(host) ?? [] }, minuteRows, hostStopped);
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: first.window.from_ms, to_ms: second.window.to_ms },
      hop: "edge_origin",
      module,
      reason: null,
      upstream: "witnessed",
      observed: `the uptime probe failed ${str(first, "target")} twice running, and both buckets carried origin-failure traffic`,
      facts: [cite("two consecutive uptime checks failed", [first, second]), cite("the buckets behind them carried origin failures", byHost.get(host) ?? [])],
      hypothesis: { text: "the origin is unreachable from every vantage: probe and real traffic agree", falsified_by: "a passing uptime check inside the window" },
      falsify: { absence: null, attribution: "a passing uptime check or counted buckets without the statuses" },
    };
  }
  return { status: "pass" };
}
