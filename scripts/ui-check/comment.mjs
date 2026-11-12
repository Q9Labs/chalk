// The one sticky pull request comment. The marker lets the workflow find and update it on every push.
const MARKER = "<!-- chalk-ui-check -->";

const CHECK_NAMES = {
  blank: "blank screen",
  "page-scroll": "page scrolls sideways",
  "viewport-overflow": "runs off the screen",
  "child-clipped": "cut off by its parent",
  "text-clipped": "text clipped",
  "control-overlap": "controls overlap",
  "control-covered": "control covered",
  "tap-target": "tap target too small",
  "dead-control": "control does nothing",
  "control-unreachable": "control unreachable",
  "never-ready": "never finished loading",
  "console-error": "console error",
  "journey-failed": "journey NOT RUN",
  "frame-unfilled": "content does not fill its round frame",
};
const MAX_ROWS = 20;
const MAX_IMAGES = 6;

const stepName = (frame) => {
  const step = frame.split(".").slice(-1)[0];
  return step === "0" ? "opened" : `step ${step}`;
};

/** @param {{ report: object, imageBase: string | undefined, frames: { frame: string, shot: string | null }[] }} input */
export function renderComment({ report, imageBase, frames }) {
  const { findings, review, comparisons } = report;
  const blockingReview = review.findings.filter((finding) => finding.blocking);
  const total = findings.length + blockingReview.length;
  const verdict = report.blocking ? `${total} finding${total === 1 ? "" : "s"} to fix` : isReviewed(review) ? "passed" : "passed the layout checks, NOT reviewed by the model";
  const lines = [MARKER, `## UI check: ${verdict}`, ""];
  lines.push(
    `Walked ${report.runs} journey runs (${report.frames} frames: pre-join, calls of 1 to 10 people, panels and sheets, toggles, leave) at phone 390, tablet 820 and desktop 1440, light and dark, on this branch and on \`${report.baseRef}\`. ${report.changedFrames} frames look different from the base. Took ${report.seconds}s.`,
    "",
  );

  if (findings.length === 0) lines.push("**Layout checks:** nothing new compared with the base.", "");
  else {
    lines.push(`**Layout checks:** ${findings.length} new problem${findings.length === 1 ? "" : "s"} that the base does not have.`, "", "| Journey | Size | Theme | Problem | Detail |", "| --- | --- | --- | --- | --- |");
    for (const finding of findings.slice(0, MAX_ROWS)) {
      lines.push(`| ${finding.label} (${stepName(finding.frame)}) | ${finding.size} | ${finding.scheme} | ${CHECK_NAMES[finding.check] ?? finding.check} | ${finding.detail.replace(/\|/gu, "/")} |`);
    }
    if (findings.length > MAX_ROWS) lines.push(`| … | | | | ${findings.length - MAX_ROWS} more in report.json |`);
    lines.push("");
  }

  lines.push(`**Vision review:** ${describeReview(review)}`, "");
  for (const finding of review.findings) lines.push(`- ${finding.blocking ? "Blocking" : "Not blocking (outside the changed region)"}: ${finding.label}, ${finding.size}, ${finding.scheme}. ${finding.finding}`);
  if (review.findings.length > 0) lines.push("");

  const withImages = [...new Set([...blockingReview.map((item) => item.frame), ...findings.map((item) => item.frame)])].slice(0, MAX_IMAGES);
  if (withImages.length > 0) {
    lines.push("Before (left, base) and after (right, this branch), changed regions boxed in red:", "");
    for (const frame of withImages) {
      const changed = comparisons.some((item) => item.frame === frame && item.changed > 0);
      const file = changed ? `diff/${frame}.review.jpg` : `head/${frames.find((item) => item.frame === frame)?.shot}`;
      lines.push(imageBase ? `<details open><summary>${frame}</summary>\n\n![${frame}](${imageBase}/${file})\n\n</details>` : `- ${frame}: \`${file}\` in the ui-check-report artifact`);
    }
    lines.push("");
  }
  lines.push("Reproduce locally: `node scripts/ui-check/run.mjs --base origin/master`", "");
  return lines.join("\n");
}

/** True when the model looked at every screen that needed it; a skipped or failed review is not a pass. */
export const isReviewed = (review) => review.status === "ok" || review.status === "nothing-to-review";

function describeReview(review) {
  if (review.status === "nothing-to-review") return "no screen changed enough to review.";
  if (review.status === "skipped-no-token") return "**NOT RUN**: this run has no Claude token (pull requests from forks get none, and the repository secret `CLAUDE_CODE_OAUTH_TOKEN` may be missing). Only the layout checks decided, so do not read this as a pass for the look of the changed screens.";
  if (review.status !== "ok") return `**NOT RUN** (${review.status}${review.error ? `: ${review.error}` : ""}). Only the layout checks decided, so do not read this as a pass for the look of the changed screens.`;
  return `${review.reviewed} changed screens reviewed by Claude Opus 5.5, ${review.findings.length === 0 ? "nothing visibly broken" : `${review.findings.length} flagged`}.`;
}
