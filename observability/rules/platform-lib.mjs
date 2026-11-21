// @ts-check
// Shared helpers for the platform rules: observation reads and the counting
// windows the spec fixes (samples, consecutive runs, five-minute buckets).

export const FIVE_MIN = 300_000;
export const DEPLOY_LEAD_MS = 30 * 60_000;
export const DEPLOY_SLACK_MS = 120_000;

/** @param {unknown} reading */
export const present = (reading) => (reading?.kind === "present" ? reading.observations : null);

/** @param {unknown} reading */
export const absent = (reading) => reading?.kind === "absent";

/** @param {Readonly<{value: Record<string, unknown>}>} o @param {string} field */
export const num = (o, field) => {
  const v = o.value[field];
  return typeof v === "number" && Number.isFinite(v) ? v : Number(v);
};

/** @param {Readonly<{value: Record<string, unknown>}>} o @param {string} field */
export const str = (o, field) => {
  const v = o.value[field];
  return typeof v === "string" ? v : v == null ? "" : String(v);
};

/**
 * Groups one stream's samples into runs of adjacent sample_seq per source_id:
 * a missed seq or a new boot breaks the run, so "consecutive" means contiguous.
 * @param {readonly Readonly<{id: string, value: Record<string, unknown>, window: { from_ms: number, to_ms: number }}>[]} samples
 * @returns {Readonly<{id: string, value: Record<string, unknown>, window: { from_ms: number, to_ms: number }}>[][]}
 */
export function sampleRuns(samples) {
  const bySource = new Map();
  for (const o of samples) {
    const source = str(o, "source_id") || "_";
    (bySource.get(source) ?? bySource.set(source, []).get(source)).push(o);
  }
  const runs = [];
  for (const list of bySource.values()) {
    list.sort((a, b) => num(a, "sample_seq") - num(b, "sample_seq"));
    let run = [];
    for (const o of list) {
      if (run.length && num(o, "sample_seq") !== num(run[run.length - 1], "sample_seq") + 1) {
        runs.push(run);
        run = [];
      }
      run.push(o);
    }
    if (run.length) runs.push(run);
  }
  return runs;
}

/**
 * Runs of adjacent-minute rows for a collector claim: two rows are consecutive only when the minutes their stamps fall in
 * touch. A point-stamped row counts in the minute that holds it.
 * @param {readonly Readonly<{id: string, value: Record<string, unknown>, window: { from_ms: number, to_ms: number }}>[]} rows
 * @param {(o: any) => boolean} test
 */
export function minuteRuns(rows, test) {
  const sorted = [...rows].sort((a, b) => a.window.from_ms - b.window.from_ms);
  const runs = [];
  let run = [];
  let minute = Number.NEGATIVE_INFINITY;
  for (const o of sorted) {
    const at = Math.floor(o.window.from_ms / 60_000);
    if (!test(o)) {
      if (run.length) runs.push(run);
      run = [];
      minute = Number.NEGATIVE_INFINITY;
      continue;
    }
    if (run.length && at > minute + 1) {
      runs.push(run);
      run = [];
    }
    if (!run.length || at > minute) {
      run.push(o);
      minute = at;
    }
  }
  if (run.length) runs.push(run);
  return runs;
}

/**
 * Maximal sub-runs of qualifying samples inside one contiguous seq run.
 * @param {readonly any[]} run
 * @param {(o: any) => boolean} test
 */
export function qualifyingRuns(run, test) {
  const out = [];
  let current = [];
  for (const o of run) {
    if (test(o)) current.push(o);
    else if (current.length) {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out;
}

/**
 * The largest stretch of [from,to] not covered by the given point/near-point
 * windows: edges count, so a dead emitter shows as a hole, not an absence.
 * @param {{ from_ms: number, to_ms: number }} span
 * @param {readonly { window: { from_ms: number, to_ms: number } }[]} rows
 */
export function largestHole(span, rows) {
  const ats = [...new Set(rows.map((o) => o.window.from_ms))].sort((a, b) => a - b);
  let hole = Math.max(0, (ats[0] ?? span.to_ms) - span.from_ms, span.to_ms - (ats[ats.length - 1] ?? span.from_ms));
  for (let i = 1; i < ats.length; i++) hole = Math.max(hole, ats[i] - ats[i - 1]);
  return hole;
}

/** Buckets one host's rollup rows by bucket_start_ms; health-class rows never count. @param {readonly any[]} rows */
export function buckets(rows, { health = false } = {}) {
  const byBucket = new Map();
  for (const o of rows) {
    const klass = str(o, "path_class");
    if (!health && klass === "health") continue;
    const key = num(o, "bucket_start_ms");
    const list = byBucket.get(key) ?? [];
    list.push(o);
    byBucket.set(key, list);
  }
  return byBucket;
}

/** The bucket each host has an ok collector tick for. @param {readonly any[]} ticks */
export function okTicks(ticks) {
  const ok = new Map();
  for (const o of ticks) {
    if (str(o, "tick_status") !== "ok") continue;
    const key = `${str(o, "host")}|${num(o, "bucket_start_ms")}`;
    ok.set(key, o);
  }
  return ok;
}

/** Requests one bucket counted, optionally filtered. @param {readonly any[]} rows @param {(o: any) => boolean} [test] */
export const requests = (rows, test = () => true) => rows.filter(test).reduce((sum, o) => sum + num(o, "requests"), 0);

/** Adjacent bucket keys present for a host, sorted. @param {Map<number, any[]>} byBucket */
export const bucketStarts = (byBucket) => [...byBucket.keys()].sort((a, b) => a - b);

/** @param {number} ms */
export const median = (values) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
};

/** One fact citation. @param {string} text @param {readonly any[]} evidence @param {{ from_ms: number, to_ms: number } | null} [window] */
export const cite = (text, evidence, window = null) => ({
  text,
  evidence: evidence.map((o) => o.id),
  window: window ?? (evidence.length ? { from_ms: Math.min(...evidence.map((o) => o.window.from_ms)), to_ms: Math.max(...evidence.map((o) => o.window.to_ms)) } : null),
  absent: null,
});
