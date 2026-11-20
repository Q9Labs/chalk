// @ts-check
// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
// The watermark of a client source in a live World: how far its telemetry ledger and its stored rows prove it complete.
import { seatKey } from "../proof/profile.mjs";
import { deliveredRows, observedEmits, storedSeq } from "./delivery.mjs";

/** @typedef {import("../proof/profile.mjs").Seat} Seat */
/** @typedef {import("../proof/evidence.mjs").Watermark} Watermark */
/** @typedef {import("../proof/evidence.mjs").EvidenceGap} EvidenceGap */
/** @typedef {import("./world.mjs").Row} Row */
/** @typedef {import("./world.mjs").Ledger} Ledger */
/** @typedef {import("./world.mjs").LedgerGap} LedgerGap */
/** @typedef {import("./world.mjs").LedgerSource} LedgerSource */

/**
 * Where one ledger source's records stop and where its gaps fall in time, from the source's own rows (`source_id`, `seq`,
 * `est_server_ms` widened by `clock_err_ms`). A gap runs from the earlier to the later of its neighbours, the last row before it
 * (the Episode's start when there is none) and the first row at or after its end, so a clock that stepped back between them still
 * leaves the gap covering both. Gaps are half-open, so a gap ends just after its later neighbour's time, and it has no end when the
 * ledger knows none or no later row exists. A seq the ledger stored but Axiom returned no timed row for is a gap too (`unread`): its
 * record was never read, so it can't count as absent. A seq the API refused for its content (`rejected`, such as a record from a
 * newer SDK) is a gap the ledger reports, although it counts it as delivered. A closed source is complete to its own close (its last
 * row, or the ledger's last receipt from it when that is later), never further: after it closed, only another source can speak for the
 * seat. Any other source is complete only to its highest stored row that Axiom returned. `from_ms` is the source's first row.
 * @param {LedgerSource} source
 * @param {readonly Row[]} rows
 * @param {{ start_ms: number }} at
 * @returns {{ complete_to_ms: number | null, evidence_gaps: EvidenceGap[], from_ms: number | null, closed: boolean }}
 */
export function sourceCoverage(source, rows, { start_ms }) {
  const timed = rows
    .flatMap((row) => {
      if (row.source_id !== source.source_id || typeof row.seq !== "number" || typeof row.est_server_ms !== "number" || !storedSeq(source, row.seq)) return [];
      const err = typeof row.clock_err_ms === "number" ? row.clock_err_ms : 0;
      return [{ seq: row.seq, at: row.est_server_ms, from: row.est_server_ms - err, to: row.est_server_ms + err }];
    })
    .sort((a, b) => a.seq - b.seq);
  const read = new Set(timed.map((row) => row.seq));
  const place = (/** @type {number} */ from_seq, /** @type {number | null} */ to_seq, /** @type {string} */ reason) => {
    const prev = timed.findLast((row) => row.seq < from_seq);
    const next = to_seq === null ? undefined : timed.find((row) => row.seq >= to_seq);
    return {
      from_ms: Math.min(prev?.from ?? start_ms, next?.from ?? Infinity),
      to_ms: next === undefined ? null : Math.max(next.to, prev?.to ?? -Infinity) + 1,
      reason,
    };
  };
  /** @type {LedgerGap[]} */
  const unread = [];
  for (const range of source.watermark.stored ?? []) {
    for (let seq = range.from; seq < range.to; seq += 1) {
      if (read.has(seq)) continue;
      const run = unread.at(-1);
      if (run !== undefined && run.to_seq === seq) unread[unread.length - 1] = { ...run, to_seq: seq + 1 };
      else unread.push({ source_id: source.source_id, from_seq: seq, to_seq: seq + 1, cause: "unread", status: "open" });
    }
  }
  // The ledger reports rejected ranges as gaps; a ledger that only lists them in the watermark still makes them gaps, once.
  const reported = new Set(source.gaps.map((gap) => `${gap.cause}|${gap.from_seq}|${gap.to_seq}`));
  const rejected = (source.watermark.rejected ?? []).flatMap((range) =>
    reported.has(`rejected|${range.from}|${range.to}`) ? [] : [{ source_id: source.source_id, from_seq: range.from, to_seq: range.to, cause: "rejected", status: /** @type {const} */ (source.watermark.end === null ? "open" : "final") }],
  );
  const evidence_gaps = [...source.gaps, ...unread, ...rejected].sort((a, b) => a.from_seq - b.from_seq).map((gap) => place(gap.from_seq, gap.to_seq, `${gap.cause}${gap.drop_reason ? `(${gap.drop_reason})` : ""} seq ${gap.from_seq}..${gap.to_seq ?? "?"} ${gap.status}`));
  const from_ms = timed.length === 0 ? null : Math.min(...timed.map((row) => row.from));
  if (source.watermark.end === "closed") {
    const received = source.watermark.last_received_at === undefined ? NaN : Date.parse(source.watermark.last_received_at);
    const ends = [...timed.map((row) => row.to), ...(Number.isNaN(received) ? [] : [received])];
    return { complete_to_ms: ends.length === 0 ? null : Math.max(...ends), evidence_gaps, from_ms, closed: true };
  }
  const stored = source.watermark.stored ?? [];
  const highest = stored.length === 0 ? null : Math.max(...stored.map((range) => range.to - 1));
  const last = highest === null ? undefined : timed.findLast((row) => row.seq <= highest);
  return { complete_to_ms: last?.at ?? null, evidence_gaps, from_ms, closed: false };
}

/**
 * @param {readonly number[]} open how far each source that never closed is complete
 * @param {boolean} outlived whether the closed sources reach the seat's leave
 * @param {number} covered_to_ms the last time any source covers
 * @param {number} asof_ms
 */
function seatCompleteTo(open, outlived, covered_to_ms, asof_ms) {
  if (open.length > 0) return Math.min(...open);
  return outlived ? asof_ms : covered_to_ms;
}

/**
 * Where a seat's sources together leave its Postgres window uncovered: between one source's end and the next one's first row. The
 * first source of a seat stands for the seat from its join; the time after the last source is the watermark's tail, not a hole.
 * @param {readonly { from_ms: number | null, complete_to_ms: number }[]} spans each source's first row and how far it is complete
 * @param {{ from_ms: number, to_ms: number }} window
 * @returns {{ holes: EvidenceGap[], covered_to_ms: number }}
 */
function seatHoles(spans, window) {
  const sorted = [...spans].sort((a, b) => (a.from_ms ?? -Infinity) - (b.from_ms ?? -Infinity));
  /** @type {EvidenceGap[]} */
  const holes = [];
  let reached = window.from_ms;
  for (const [index, span] of sorted.entries()) {
    const from = index === 0 ? window.from_ms : (span.from_ms ?? window.from_ms);
    if (from > reached && reached < window.to_ms) holes.push({ from_ms: reached, to_ms: Math.min(from, window.to_ms), reason: "no ledger source of the seat covers this time" });
    reached = Math.max(reached, span.complete_to_ms);
  }
  return { holes, covered_to_ms: reached };
}

/**
 * The client watermark of one seat, folded over every ledger source that names its Participant. A source that never closed bounds
 * the seat at its highest row. Closed sources speak for the seat only between their first row and their close, so time in the seat's
 * Postgres window (join to leave) that no source covers is a gap, and the seat is complete to `asof_ms` only when every source closed
 * and the last close came at or after the seat left; otherwise it is complete only to the last close. A page the ledger never heard of,
 * because its first batch was refused or never sent, therefore leaves the seat partial. A seat no source names was not read.
 * @param {Pick<Seat, "participant" | "window">} seat
 * @param {Ledger} ledger
 * @param {readonly Row[]} rows
 * @param {{ asof_ms: number, start_ms: number }} at
 * @returns {Watermark}
 */
export function clientWatermark({ participant, window }, ledger, rows, at) {
  const subject = seatKey(participant);
  const sources = "unavailable" in ledger ? [] : ledger.sources.filter((source) => source.watermark.participants.includes(participant));
  const mine = new Set(sources.map((source) => source.source_id));
  const base = {
    source: "client",
    subject,
    emits: observedEmits(
      deliveredRows(rows, sources).usable.filter((row) => mine.has(String(row.source_id))),
      "client",
    ),
  };
  if ("unavailable" in ledger) return { ...base, complete_to_ms: null, evidence_gaps: [], build: `client (ledger unread: ${ledger.unavailable})` };
  if (sources.length === 0) return { ...base, complete_to_ms: null, evidence_gaps: [], build: "client (no ledger source)" };
  const covered = sources.map((source) => sourceCoverage(source, rows, at));
  const build = `client (${sources.length} ledger source${sources.length === 1 ? "" : "s"})`;
  const gaps = covered.flatMap((c) => c.evidence_gaps);
  const spans = covered.flatMap((c) => (c.complete_to_ms === null ? [] : [{ from_ms: c.from_ms, complete_to_ms: c.complete_to_ms }]));
  if (spans.length < covered.length) return { ...base, complete_to_ms: null, evidence_gaps: gaps, build };
  const left = window.to_ms;
  const { holes, covered_to_ms } = seatHoles(spans, { from_ms: window.from_ms, to_ms: left ?? at.asof_ms });
  const open = covered.filter((c) => !c.closed).map((c) => /** @type {number} */ (c.complete_to_ms));
  return { ...base, complete_to_ms: seatCompleteTo(open, left !== null && covered_to_ms >= left, covered_to_ms, at.asof_ms), evidence_gaps: [...gaps, ...holes], build };
}
