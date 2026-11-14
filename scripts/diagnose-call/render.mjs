// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { SOURCES, joinedShare } from "./join.mjs";
import { attr } from "./rows.mjs";
import { verdictLine } from "./verdict.mjs";

/** Where a result still depends on time. None of these decides which rows belong to the call. */
const TIMESTAMP_USES = [
  "A call_stats sample's own time is its connection's media start plus `elapsed_ms`; the start is the earliest upload time minus `elapsed_ms` among the rows of that one connection id.",
  "Media silence needs a sender: it compares sample windows of two Participants of the same Episode and asks whether they overlap.",
  "Early replacement subtracts the Participant's join time (database row, else first row) from the replacement row's time; both rows are already joined by id.",
  "A cause is the last node event of the same connection id before the problem ended, picked by order of time.",
  "Queries scan 14 days back, and the orphan probe scans the call's span plus one minute; these bound the scan and never join.",
  "The Cloudflare plane's own logs are not read. Its session id is only a field on Chalk's rows, so nothing there can be joined, by id or by time.",
];

const clock = (ms) => new Date(ms).toISOString().slice(11, 19);
const pct = (share) => `${Math.round(share * 1000) / 10}%`;

function timeline(rows, findings) {
  const notable = rows.filter((row) => row.event !== "sdk.call_stats" || Number(attr(row, "recv_bitrate_kbps")) === 0);
  const lines = notable.slice(0, 80).map((row) => {
    const detail = ["replacement_cause", "trigger", "reason", "cause", "error_code", "layer", "ceiling", "server_limit"]
      .map((name) => (attr(row, name) === undefined ? undefined : `${name}=${attr(row, name)}`))
      .filter(Boolean)
      .join(" ");
    return `  ${clock(row.time)}  ${row.source.padEnd(6)} ${row.event.padEnd(34)} ${row.participant ? row.participant.slice(0, 8) : "-"}  ${detail}`.trimEnd();
  });
  if (notable.length > 80) lines.push(`  ... ${notable.length - 80} more rows`);
  for (const finding of findings) lines.push(`  ${clock(finding.from)}  FOUND  ${finding.kind} [${finding.stage}/${finding.side}]: ${finding.experience}`);
  return lines;
}

export function render({ episodeId, joined, stats, findings, missing, truncated, elapsedMs }) {
  const out = [`Episode ${episodeId}`, "", `VERDICT: ${verdictLine(findings)}`, "", "Timeline (UTC)", ...timeline(joined, findings), "", "Rows joined by id"];
  out.push(`  ${"source".padEnd(8)}${"rows".padStart(6)}${"episode".padStart(9)}${"connection".padStart(12)}${"journey".padStart(9)}${"unjoined".padStart(10)}${"by id".padStart(8)}`);
  let total = 0;
  let reached = 0;
  for (const source of SOURCES) {
    const stat = stats[source];
    total += stat.rows;
    reached += stat.episode + stat.connection + stat.journey;
    out.push(`  ${source.padEnd(8)}${String(stat.rows).padStart(6)}${String(stat.episode).padStart(9)}${String(stat.connection).padStart(12)}${String(stat.journey).padStart(9)}${String(stat.unjoined).padStart(10)}${pct(joinedShare(stat)).padStart(8)}`);
  }
  out.push(`  ${"all".padEnd(8)}${String(total).padStart(6)}${" ".repeat(30)}${pct(total === 0 ? 1 : reached / total).padStart(8)}`);
  out.push("", "Timestamps still used", ...TIMESTAMP_USES.map((use) => `  - ${use}`));
  const gaps = [...missing, ...(truncated ? ["a query returned its row cap, so older rows may be missing"] : [])];
  out.push("", "Missing evidence", ...(gaps.length > 0 ? gaps.map((gap) => `  - ${gap}`) : ["  - none"]));
  out.push("", `Elapsed: ${(elapsedMs / 1000).toFixed(1)} s`);
  return out.join("\n");
}
