// Renders the optional `diagnostics` block of a scorecard: the runner's round trips and the stage timings behind each action.
// Nothing here reads a budget or changes a verdict; it only explains where an action's time went.
import { RTT_KEYS, STAGE_GROUPS } from "./stages.mjs";

const LABELS = { sfu_ms: "SFU", sync_ms: "Sync" };
const stat = (value) => (value && value.n > 0 ? `${value.p50} / ${value.p95} ms (n=${value.n})` : "no samples");

/**
 * @param {import("./schema.mjs").ScorecardDiagnostics | undefined} diagnostics
 * @returns {string} Markdown, or "" when the card has no diagnostics.
 */
export function diagnosticsMarkdown(diagnostics) {
  if (!diagnostics) return "";
  const lines = ["#### Action latency diagnostics", "", "Informational: no budget, gate or verdict reads these. Times are p50 / p95 per cycle.", ""];
  const rtt = RTT_KEYS.filter((key) => diagnostics.rtt?.[key]).map((key) => `${LABELS[key]} ${stat(diagnostics.rtt?.[key])}`);
  if (rtt.length) lines.push(`Round trip from the runner: ${rtt.join("; ")}.`, "");
  for (const group of STAGE_GROUPS) {
    const rows = group.stages.filter((stage) => diagnostics.stages?.[`${group.id}.${stage.id}`]);
    if (!rows.length) continue;
    lines.push(`**${group.title}** (${group.metrics})`, "", "| Stage | Since | n | p50 | p95 | What it covers |", "|---|---|---|---|---|---|");
    for (const stage of rows) {
      const value = diagnostics.stages?.[`${group.id}.${stage.id}`];
      lines.push(`| \`${stage.id}\` | ${stage.from === "call" ? "call" : "previous stage"} | ${value?.n} | ${value?.p50 ?? "–"} | ${value?.p95 ?? "–"} | ${stage.description} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}
