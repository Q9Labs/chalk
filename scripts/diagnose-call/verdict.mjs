// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { clock, short } from "./call.mjs";
import { missingSources } from "./gaps.mjs";

/**
 * The one line a person reads: who, what they lived through, from when to when, the failing stage and side, and why.
 * The sources the diagnosis could not read come last, because they say how far to trust it. With no bad finding the line says
 * "not enough evidence" whenever a source is missing, and says "no bad call" only when every source was read.
 */
export function verdictLine(findings, gaps, call) {
  const missing = missingSources(gaps);
  const bad = findings.filter((finding) => !finding.benign);
  const note = findings.find((finding) => finding.benign);
  const absent = missing.length > 0 ? ` Missing sources: ${missing.join(", ")}.` : "";
  if (call.rows.length === 0) return `Not enough evidence: no row reached this Episode.${absent}`;
  if (bad.length === 0) {
    const noted = note ? ` Participant ${short(note.participant)} ${note.experience} (stage: ${note.stage}, side: ${note.side}, ${note.kind === "recovered_drop" ? "recovered on its own" : "by choice"}).` : "";
    if (missing.length > 0) return `Not enough evidence: the rules found no failure in the rows that were read.${noted}${absent}`;
    return `No bad call found by the rules in the rows of every source.${noted}`;
  }
  const first = bad[0];
  const window = first.from === first.to ? `at ${clock(first.from)}` : `from ${clock(first.from)} to ${clock(first.to)}`;
  const more = bad.length === 2 ? " 1 more finding follows." : bad.length > 2 ? ` ${bad.length - 1} more findings follow.` : "";
  return `Participant ${short(first.participant)} ${first.experience} ${window} UTC; failing stage: ${first.stage}, side: ${first.side}; cause: ${first.cause}.${more}${absent}`;
}
