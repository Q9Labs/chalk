// fallow-ignore-file complexity -- the rules branch on every kind of evidence; diagnose-call.test.mjs covers each branch, which the CRAP estimate cannot see.
import { SOURCES } from "./join.mjs";
import { clock, short } from "./call.mjs";

const proofOf = ({ ids, total }) => `[${ids.join(", ")}${total > ids.length ? `, ... ${total} rows in all` : ""}]`;

function stepLine(step) {
  const mark = step.finding === "problem" ? "▶" : step.finding === "note" ? "·" : " ";
  return `  ${mark} ${clock(step.time)}  ${step.stage.padEnd(12)}${step.side.padEnd(9)}${step.text}  ${proofOf(step.proof)}`;
}

function header(timeline) {
  const role = timeline.role ? ` (${timeline.role})` : "";
  const joined = timeline.joined === undefined ? "no database row" : `joined ${clock(timeline.joined)}${timeline.left ? `, left ${timeline.left.slice(11, 19)} (${timeline.leftReason ?? "reason not logged"})` : ", did not leave"}`;
  return `Participant ${short(timeline.participant)}${role}: ${joined}`;
}

/** The summary, one timeline per Participant, and the list of what the diagnosis could not see. */
export function render({ episodeId, plane, verdict, findings, gaps, stats, timeline, elapsedMs }) {
  const out = [`Episode ${episodeId}`, "", `VERDICT: ${verdict}`, ""];
  const bad = findings.filter((finding) => !finding.benign);
  out.push("Summary");
  out.push("  Timeline columns: time UTC, stage, side, what happened, ids of the rows that prove it. ▶ marks a finding, · a note.");
  out.push(`  Rows by source: ${SOURCES.map((source) => `${source} ${stats[source].rows}`).join(", ")}`);
  if (plane) out.push(`  Media plane: ${plane.provider ?? "provider not logged"}, chosen by ${plane.selectedBy} ${proofOf({ ids: plane.proof.map((row) => row.id), total: plane.proof.length })}`);
  if (bad.length === 0) out.push("  Findings: none that fail the call");
  for (const finding of bad) {
    out.push(`  Finding: Participant ${short(finding.participant)} ${finding.experience} at ${clock(finding.from)} UTC [${finding.stage}/${finding.side}] ${finding.cause} ${proofOf(finding.proof)}`);
    out.push(...finding.notes.map((note) => `    Note: ${note}`));
  }
  for (const finding of findings.filter((candidate) => candidate.benign)) out.push(`  Note: Participant ${short(finding.participant)} ${finding.experience} [${finding.stage}/${finding.side}]`);
  for (const one of timeline.participants) {
    out.push("", header(one));
    out.push(...one.steps.map(stepLine));
    if (one.left_out > 0) out.push(`    ... ${one.left_out} routine steps left out of the middle`);
  }
  if (timeline.episode.length > 0) out.push("", "Episode-wide rows", ...timeline.episode.map(stepLine));
  out.push("", "Missing data");
  out.push(...(gaps.length > 0 ? gaps.map((gap) => `  - ${gap.blocks ? "[blocks the verdict] " : ""}${gap.what}`) : ["  - none"]));
  out.push("", `Elapsed: ${(elapsedMs / 1000).toFixed(1)} s`);
  return out.join("\n");
}
