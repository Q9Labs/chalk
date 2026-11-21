// @ts-check
/**
 * release.failures_after_change: an API or Sync 5xx surge within an hour of a
 * release marker, a media-plane change or a boot config change. Edge buckets
 * count errors where an ok tick exists and api rows only where the edge
 * cannot, so one request never counts twice. A deploy's own restart window is
 * the one expected surge, reason release.deploy_restart.
 */
import { FIVE_MIN, bucketStarts, buckets, cite, median, num, okTicks, present, requests, str } from "./platform-lib.mjs";

/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").DecideInput} DecideInput */
/** @typedef {import("../../scripts/diagnose-call/proof/profile.mjs").Decision} Decision */

export const symptom = "release.failures_after_change";
export const expected = "no API or Sync 5xx surge follows a release marker, a media-plane change or a boot config change within an hour";
/** A day with no marker, no change and no edge traffic has no anchor to blame; those absences are the healthy claim. */
export const healthy_absent = ["release.marker", "db.change", "edge.bucket"];

const ANCHOR_AFTER_MS = 60 * 60_000;
const BASELINE_BUCKETS = 288;
const BASELINE_MIN_COUNTED = 144;
const SURGE_BUCKETS = 12;
const SURGE_MIN_ERRORS = 10;
const SURGE_FACTOR = 3;
const FAULT_COMPONENTS = new Set(["api", "sync", "web", "recorder"]);
const SERVER_HOSTS = /^(api|sync)\./;

/** @param {unknown} declaration @param {unknown} seat */
export const applies = (declaration, seat) => declaration?.kind === "platform";

/**
 * @param {DecideInput} input
 * @returns {Decision}
 */
export function decide({ readings, failures, window }) {
  const markers = (present(readings["release.marker"]) ?? []).filter((o) => o.source === "release");
  const changes = present(readings["db.change"]) ?? [];
  const snapshots = (present(readings["flags.snapshot"]) ?? []).filter((o) => o.source === "api").sort((a, b) => a.window.from_ms - b.window.from_ms);
  const rollups = (present(readings["edge.bucket"]) ?? []).filter((o) => o.source === "edge");
  const ticks = okTicks((present(readings["edge.tick"]) ?? []).filter((o) => o.source === "edge"));
  const apiErrors = (present(readings["release.request"]) ?? []).filter((o) => o.source === "api" && str(o, "status_class") === "s5xx");

  // Anchors: markers of every kind, media-plane changes, and api boots whose
  // flags_hash differs from the previous api boot's.
  const anchors = [
    ...markers.map((o) => ({ at: num(o, "finished_ms"), kind: `marker:${str(o, "component")}`, component: str(o, "component"), marker: o })),
    ...changes.map((o) => ({ at: num(o, "changed_at_ms"), kind: `media_plane:${str(o, "media_plane_scope")}`, component: null, marker: o })),
    ...snapshots.slice(1).flatMap((o, i) => {
      const before = snapshots[i];
      return str(o, "flags_hash") !== str(before, "flags_hash") ? [{ at: o.window.from_ms, kind: "flags_hash", component: null, marker: o, before }] : [];
    }),
  ].sort((a, b) => a.at - b.at);
  if (anchors.length === 0) return { status: "pass" };

  // Errors per (host, bucket) on api.* and sync.* hosts, edge first, api where
  // no ok tick makes the bucket real.
  const byHost = new Map();
  for (const o of rollups) {
    const host = str(o, "host");
    if (!SERVER_HOSTS.test(host)) continue;
    const list = byHost.get(host) ?? [];
    list.push(o);
    byHost.set(host, list);
  }
  const perBucket = new Map(); // `${host}|${start}` -> {edge5xx, origin0, apiOnly5xx, rows, counted}
  for (const [host, rows] of byHost) {
    for (const [start, group] of buckets(rows)) {
      const counted = ticks.has(`${host}|${start}`);
      const five = group.filter((o) => num(o, "edge_status") >= 500);
      perBucket.set(`${host}|${start}`, {
        host,
        start,
        counted,
        edge5xx: requests(five),
        origin0: requests(five, (o) => num(o, "origin_status") === 0),
        restartKind: requests(five, (o) => (num(o, "edge_status") === 502 || num(o, "edge_status") === 530) && num(o, "origin_status") === 0),
        rows: group,
      });
    }
  }
  const bucketError = (host, start) => {
    const bucket = perBucket.get(`${host}|${start}`);
    if (bucket?.counted) return { count: bucket.edge5xx, origin0: bucket.origin0, restart: bucket.restartKind, via: "edge", rows: bucket.rows };
    if (host.startsWith("api.")) {
      const api = apiErrors.filter((o) => o.window.from_ms >= start && o.window.from_ms < start + FIVE_MIN);
      return { count: api.length, origin0: 0, restart: api.filter((o) => num(o, "status") === 503).length, via: "api", rows: api };
    }
    return { count: 0, origin0: 0, restart: 0, via: "edge" };
  };
  const hosts = [...new Set([...perBucket.values()].map((b) => b.host).concat(apiErrors.length ? ["api."] : []))];

  // For each anchor: surge buckets inside the hour after it. For deploy
  // markers the window opens at the deploy's start so a restart surge inside
  // the deploy span is judged by the expected path instead of being missed.
  for (const anchor of anchors) {
    const deployMarker = anchor.kind.startsWith("marker:") && str(anchor.marker, "marker_kind") === "deploy" ? anchor.marker : null;
    const from = deployMarker ? Math.min(num(deployMarker, "started_ms"), anchor.at) : anchor.at;
    const after = { from_ms: from, to_ms: anchor.at + ANCHOR_AFTER_MS };
    const surge = [];
    for (const host of hosts) {
      const start0 = Math.floor(after.from_ms / FIVE_MIN) * FIVE_MIN;
      for (let start = start0; start < after.to_ms && surge.length < SURGE_BUCKETS; start += FIVE_MIN) {
        const counted = perBucket.get(`${host}|${start}`)?.counted || host === "api.";
        if (!counted) continue;
        const e = bucketError(host, start);
        surge.push({ host, start, ...e });
      }
    }
    if (surge.length === 0) continue;
    // Baseline: median per-bucket error count over [anchor-24h, anchor).
    const countedBase = [];
    for (const host of hosts) {
      const start0 = Math.floor((anchor.at - 24 * 3600_000) / FIVE_MIN) * FIVE_MIN;
      for (let start = start0; start < anchor.at; start += FIVE_MIN) {
        if (!perBucket.get(`${host}|${start}`)?.counted && !(host === "api." && apiErrors.length)) continue;
        countedBase.push(bucketError(host, start).count);
      }
    }
    const baseline = countedBase.length >= BASELINE_MIN_COUNTED ? median(countedBase) : 0;
    const hot = surge.filter((b) => b.count >= SURGE_MIN_ERRORS && b.count >= SURGE_FACTOR * baseline);
    if (hot.length < 2) continue;
    const firstHot = hot.sort((a, b) => a.start - b.start)[0];

    // deploy_restart preconditions.
    const marker = anchor.kind.startsWith("marker:") ? anchor.marker : null;
    if (marker && str(marker, "marker_kind") === "deploy") {
      const span = { from_ms: num(marker, "started_ms") - 120_000, to_ms: num(marker, "finished_ms") + 120_000 };
      const boots = (present(readings["flags.boot"]) ?? []).filter((o) => str(o, "release_id") === str(marker, "release_id") && o.window.from_ms >= span.from_ms && o.window.from_ms <= span.to_ms);
      const dbDown = failures.filter((o) => o.fact === "db.reachable" && o.window.from_ms <= span.to_ms && o.window.to_ms >= span.from_ms);
      const inside = hot.every((b) => b.start >= span.from_ms && b.start < span.to_ms);
      const restartOnly = hot.every((b) => b.restart === b.count);
      const afterSpan = [span.to_ms, span.to_ms + FIVE_MIN].every((start) => hosts.every((host) => bucketError(host, start).count < SURGE_MIN_ERRORS));
      if (inside && restartOnly && boots.length === 1 && dbDown.length === 0 && afterSpan) {
        return {
          status: "finding",
          outcome: "expected",
          window: span,
          hop: "release_change",
          module: null,
          reason: "release.deploy_restart",
          upstream: "witnessed",
          observed: `the 5xx surge is inside ${str(marker, "component")}'s deploy window and quiets after it`,
          facts: [cite(`the surge buckets sit inside the marker's deploy span`, [marker, ...hot.flatMap((b) => b.rows ?? [])]), cite(`exactly one boot of ${str(marker, "release_id")} falls in the span`, boots)],
          hypothesis: null,
          falsify: { absence: null, attribution: "surge errors outside the deploy span, a second boot, or errors after it" },
        };
      }
    }
    const module = anchor.component ? `${FAULT_COMPONENTS.has(anchor.component) ? anchor.component : "host"}.release` : "api.config";
    const evidence = [...(marker ? [marker] : anchor.marker ? [anchor.marker] : []), ...hot.slice(0, 3).flatMap((b) => b.rows ?? [])];
    return {
      status: "finding",
      outcome: "broken",
      window: { from_ms: firstHot.start, to_ms: Math.max(...hot.map((b) => b.start)) + FIVE_MIN },
      hop: "release_change",
      module,
      reason: null,
      upstream: "witnessed",
      observed: `${hot.length} buckets within an hour of the ${anchor.kind} anchor held at least ${SURGE_MIN_ERRORS} errors each, ${SURGE_FACTOR}x the ${baseline} baseline`,
      facts: [
        cite(`${hot.length} buckets after ${anchor.kind} exceeded the floor${countedBase.length < BASELINE_MIN_COUNTED ? " (no 24 h baseline, floor 10 used)" : ` (baseline ${baseline})`}`, hot.slice(0, 3).flatMap((b) => b.rows ?? [])),
        ...(marker || anchor.marker ? [cite(`the change it follows: ${anchor.kind}`, [marker ?? anchor.marker])] : []),
      ],
      hypothesis: { text: `the ${anchor.kind} change caused the 5xx surge`, falsified_by: `the same surge appearing before the anchor or without any change` },
      falsify: { absence: null, attribution: "surge buckets without an anchor, or an anchor with no surge" },
    };
  }
  return { status: "pass" };
}
