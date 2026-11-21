// @ts-check
/**
 * The day fill for platform fixtures: a chain's fault hop produces a handful of
 * real rows at its pinned times; this file synthesizes the rest of the UTC day
 * the item declares, at cadences under the rules' gap thresholds, so coverage
 * sees the day edge-to-edge. Fill rows carry their own source_id (`src-fill-*`)
 * and never collide on est_server_ms with the fault rows they stand beside.
 */

export const DAY = "2026-11-20";
export const DAY_START = Date.parse("2026-11-20T00:00:00Z");
export const DAY_END = DAY_START + 86_400_000;
export const HOST = "api.chalkmeet.test";
export const SYNC_HOST = "sync.chalkmeet.test";
export const WEB_HOST = "chalkmeet.test";

const fillSeq = new Map();
const kernel = (name, est, fields) => {
  const tag = `${name}|${est}|${fields?.host ?? ""}|${fields?.source_id ?? ""}`;
  const seq = (fillSeq.get(tag) ?? 0) + 1;
  fillSeq.set(tag, seq);
  return {
    kind: "fact",
    name,
    event_id: `fill-${name}-${est}-${fields?.host ?? fields?.source_id ?? "row"}-${seq}`,
    est_server_ms: est,
    env: "test",
    module: "api",
    schema_ver: "fill",
    seq: est - DAY_START,
    ...fields,
  };
};

/** One up db.health_sample from the fill source. @param {number} seq @param {number} est @param {Record<string, unknown>} [over] */
export const upSample = (seq, est, over = {}) =>
  kernel("db.health_sample", est, {
    source_id: "src-fill-health",
    sample_seq: seq,
    db_status: "ok",
    db_reach: "up",
    max_conns: 10,
    total_conns: 3,
    acquired_conns: 2,
    idle_conns: 1,
    constructing_conns: 0,
    acquire_count: 0,
    empty_acquire_count: 0,
    empty_acquire_wait_ms: 0,
    canceled_acquire_count: 0,
    active_backends: 2,
    idle_in_tx_backends: 0,
    lock_waiters: 0,
    max_lock_wait_ms: 0,
    lock_status: "ok",
    stmt_status: "unavailable(extension_missing)",
    stmt_top: "none",
    ...over,
  });

/**
 * A day of up samples every 60 s, skipping every stamp the real rows own.
 * @param {readonly number[]} skip est values the fault rows occupy
 */
export function daySamples(skip = []) {
  const taken = new Set(skip);
  const rows = [];
  for (let est = DAY_START; est < DAY_END; est += 60_000) {
    if (taken.has(est)) continue;
    rows.push(upSample(rows.length + 1, est));
  }
  return rows;
}

/** One host database-unreachable row in the read-projected shape. @param {number} est @param {number} value @param {string} [reason] */
export const hostDbRow = (est, value = 0, reason = "readable") => ({
  chalk_alert_rule: "database-unreachable",
  chalk_alert_value: value,
  chalk_alert_reason: reason,
  chalk_alert_stream: "host",
  db_reach: value === 1 ? "down" : "up",
  event_id: `fill-host-db-${est}`,
  est_server_ms: est,
  env: "test",
});

/** A day of 0-valued database rows, skipping fault stamps. @param {readonly number[]} skip */
export function dayHostDb(skip = []) {
  const taken = new Set(skip);
  const rows = [];
  for (let est = DAY_START; est < DAY_END; est += 60_000) if (!taken.has(est)) rows.push(hostDbRow(est));
  return rows;
}

/** One host runtime-health row in the read-projected shape. @param {number} est @param {number} value @param {string} [reason] */
export const hostHealthRow = (est, value = 0, reason = "healthy") => ({
  chalk_alert_rule: "runtime-health",
  chalk_alert_value: value,
  chalk_alert_reason: reason,
  chalk_alert_stream: "host",
  origin_reach: value === 1 ? "down" : "up",
  event_id: `fill-host-health-${est}`,
  est_server_ms: est,
  env: "test",
});

/** A day of healthy runtime rows, skipping fault stamps. @param {readonly number[]} skip */
export function dayHostHealth(skip = []) {
  const taken = new Set(skip);
  const rows = [];
  for (let est = DAY_START; est < DAY_END; est += 60_000) if (!taken.has(est)) rows.push(hostHealthRow(est));
  return rows;
}

/** One edge.collector_tick. @param {number} bucketStart @param {string} host @param {string} [status] */
export const tick = (bucketStart, host, status = "ok") =>
  kernel("edge.collector_tick", bucketStart + 300_000, { source_id: "src-fill-edge", module: "checker", bucket_start_ms: bucketStart, host, tick_status: status });

/** One edge.http_rollup. */
export function rollup(bucketStart, host, pathClass, edgeStatus, originStatus, requests, over = {}) {
  return kernel("edge.http_rollup", bucketStart, {
    source_id: "src-fill-edge",
    module: "checker",
    bucket_start_ms: bucketStart,
    host,
    path_class: pathClass,
    edge_status: edgeStatus,
    origin_status: originStatus,
    method: "GET",
    content_class: "other",
    ua_class: "browser",
    requests,
    ...over,
  });
}

/**
 * Ticks for every five-minute bucket of the day for the hosts the fixture uses;
 * rollups only where traffic exists, since a counted bucket with no rows is a real zero.
 * @param {{ host: string, traffic?: (start: number) => { path_class: string, edge_status: number, origin_status: number, requests: number }[], skip?: readonly number[] }[]} hosts
 */
export function dayEdge(hosts) {
  const rows = [];
  for (const { host, traffic, skip = [] } of hosts) {
    const taken = new Set(skip);
    for (let start = DAY_START; start < DAY_END; start += 300_000) {
      if (taken.has(start)) continue;
      rows.push(tick(start, host));
      for (const t of traffic?.(start) ?? []) rows.push(rollup(start, host, t.path_class, t.edge_status, t.origin_status, t.requests));
    }
  }
  return rows;
}

/** One api.http_request row (legacy shape the pipeline ships). */
export function request(est, status, over = {}) {
  return {
    event: "http.request",
    event_id: `fill-http-${est}-${status}`,
    est_server_ms: est,
    env: "test",
    module: "api",
    method: "GET",
    route: "/v1/spaces/:space/join",
    status,
    status_class: status >= 500 ? "s5xx" : status >= 400 ? "s4xx" : "s2xx",
    service_version: "2026.11.20-0000000",
    ...(status >= 400 ? { error_code: "request_failed" } : {}),
    ...over,
  };
}

/** A quiet day of api requests: a few 2xx rows every ten minutes, one stray 500 at 18:00 so error_code is witnessed. */
export function dayRequests() {
  const rows = [];
  for (let est = DAY_START; est < DAY_END; est += 600_000) rows.push(request(est, 200));
  rows.push(request(DAY_START + 18 * 3600_000, 500));
  return rows;
}

/** One boot pair: release.started + obs.flags_snapshot from the same source_id. */
export function boot(est, { sourceId, releaseId, bootId, flags, flagsHash }) {
  const bootRow = kernel("release.started", est, { source_id: sourceId, release_id: releaseId, host_boot_id: bootId, previous_boot_end: "" });
  const snap = kernel("obs.flags_snapshot", est, { source_id: sourceId, flags, flags_hash: flagsHash });
  return [bootRow, snap];
}

/** A client flags snapshot from the Chalk web app. */
export function clientBoot(est, { session, device, releaseSha, flagsHash }) {
  return kernel("client.flags_snapshot", est, {
    module: "web",
    source_id: session,
    client_session_id: session,
    device_id: device,
    release_sha: releaseSha,
    flags_hash: flagsHash,
    flags: {},
  });
}

/**
 * The coverage rows one symptom's fixture needs that its fault hops do not produce.
 * @param {string} code
 * @param {{ samples?: readonly number[], hostDb?: readonly number[], hostHealth?: readonly number[], edge?: readonly number[] }} skip est/bucket stamps the real fault rows own
 */
export function fillFor(code, skip = {}) {
  const base = [];
  if (["db.unreachable", "db.pool_saturated", "db.lock_wait"].includes(code)) base.push(...daySamples(skip.samples ?? []));
  if (code === "db.unreachable") base.push(...dayHostDb(skip.hostDb ?? []));
  if (code === "db.lock_wait") base.push(...dayRequests());
  if (code === "edge.origin_unreachable") {
    base.push(...dayHostHealth(skip.hostHealth ?? []));
    base.push(...dayEdge([{ host: HOST, skip: skip.edge ?? [] }, { host: SYNC_HOST }]));
  }
  if (code === "edge.asset_failures") base.push(...dayEdge([{ host: WEB_HOST, skip: skip.edge ?? [] }]));
  if (code === "release.failures_after_change") {
    base.push(...dayEdge([{ host: HOST, skip: skip.edge ?? [], traffic: () => [{ path_class: "other", edge_status: 200, origin_status: 200, requests: 20 }] }]));
    base.push(...dayRequests());
  }
  return base;
}
