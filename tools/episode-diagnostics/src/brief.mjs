// @ts-check

import { formatReference } from "./reference.mjs";
import { sanitizeDiagnosticData } from "./safety.mjs";

const MAX_COMPACT_CHARS = 4_000;
const MAX_MARKDOWN_CHARS = 48_000;

/**
 * Build the shared AgentBrief/v1 payload from a sanitized snapshot. The API
 * may provide a richer brief; this deterministic fallback keeps CLI and UI
 * fixtures field-for-field compatible while the service is unavailable.
 *
 * @param {Record<string, unknown>} snapshot
 * @param {{ reference: import("./reference.mjs").DiagnosticReference; focus?: Record<string, unknown>; cursor?: number; aroundSeconds?: number; branchId?: string }} options
 */
export function buildAgentBrief(snapshot, options) {
  const safeSnapshot = /** @type {Record<string, any>} */ (sanitizeDiagnosticData(snapshot));
  const reference = formatReference(options.reference);
  const arrays = briefArrays(safeSnapshot);
  const counts = briefCounts(safeSnapshot, arrays);
  const visibleGaps = mapVisibleGaps(arrays.gaps);
  return {
    ...assembleBrief(safeSnapshot, options, reference, arrays, counts, visibleGaps),
  };
}

/**
 * @param {Record<string, any>} snapshot
 * @param {{ reference: import("./reference.mjs").DiagnosticReference; cursor?: number }} options
 * @param {string} reference
 * @param {{ operations: Record<string, any>[]; issues: Record<string, any>[]; branches: Record<string, any>[]; gaps: Record<string, any>[]; releases: Record<string, any>[] }} arrays
 * @param {{ eventCount: number; operationCount: number; issueCount: number; openIssueCount: number; observedSummary: string }} counts
 * @param {Record<string, any>[]} visibleGaps
 */
function assembleBrief(snapshot, options, reference, arrays, counts, visibleGaps) {
  const brief = /** @type {Record<string, any>} */ ({ schemaVersion: "AgentBrief/v1", version: 1, reference });
  setIfDefined(brief, "focusedReference", focusedReference(options, reference));
  brief.captureTime = captureTime(snapshot);
  setIfDefined(brief, "selectedCursor", selectedCursor(options, snapshot));
  setIfDefined(brief, "runEndCursor", runEndCursor(snapshot));
  brief.observedSummary = counts.observedSummary;
  brief.environment = snapshotEnvironment(snapshot, options);
  brief.resolverCommand = `pnpm trace:inspect ${reference} --format agent`;
  brief.releaseCommits = arrays.releases;
  brief.visibleGaps = visibleGaps;
  brief.episodeSummary = episodeSummary(snapshot);
  brief.issues = arrays.issues.slice(0, 100);
  brief.operations = arrays.operations.slice(0, 100);
  brief.branches = arrays.branches.slice(0, 100);
  brief.counts = { events: counts.eventCount, operations: counts.operationCount, issues: counts.issueCount, openIssues: counts.openIssueCount, branches: arrays.branches.length };
  brief.omissions = omissions(visibleGaps);
  return brief;
}

/** @param {Record<string, any>} snapshot */
function briefArrays(snapshot) {
  return {
    operations: asArray(snapshot.operations),
    issues: asArray(snapshot.issues),
    branches: asArray(snapshot.branches),
    gaps: asArray(snapshot.gaps ?? snapshot.visibleGaps),
    releases: asArray(snapshot.releases ?? snapshot.releaseCommits).map(releaseEntry),
  };
}

/** @param {Record<string, any>} release */
function releaseEntry(release) {
  const entry = { release: stringValue(release.release ?? release.id ?? "unknown") };
  setIfDefined(entry, "sourceCommit", release.sourceCommit ? stringValue(release.sourceCommit) : undefined);
  return entry;
}

/** @param {Record<string, any>} snapshot @param {{ operations: Record<string, any>[]; issues: Record<string, any>[] }} arrays */
function briefCounts(snapshot, arrays) {
  const summary = snapshot.summary && typeof snapshot.summary === "object" ? snapshot.summary : {};
  const eventCount = numberValue(summary.eventCount ?? snapshot.eventCount, 0);
  const operationCount = numberValue(summary.operationCount, arrays.operations.length);
  const issueCount = numberValue(summary.issueCount, arrays.issues.length);
  const openIssueCount = numberValue(summary.openIssueCount, arrays.issues.filter((issue) => issue.state === "open").length);
  return { eventCount, operationCount, issueCount, openIssueCount, observedSummary: observedSummary(snapshot, eventCount, operationCount, openIssueCount) };
}

/** @param {Record<string, any>} snapshot @param {number} eventCount @param {number} operationCount @param {number} openIssueCount */
function observedSummary(snapshot, eventCount, operationCount, openIssueCount) {
  const state = stringValue(snapshot.state ?? "unknown");
  return `${state} Episode Diagnostic with ${operationCount} ${plural("operation", operationCount)}, ${openIssueCount} open ${plural("issue", openIssueCount)}, and ${eventCount} retained ${plural("Event", eventCount)}.`;
}

/** @param {Record<string, any>[]} gaps */
function mapVisibleGaps(gaps) {
  return gaps.slice(0, 64).map((gap) => visibleGap(gap));
}

/** @param {Record<string, any>} gap */
function visibleGap(gap) {
  const entry = {
    kind: gapKind(gap),
    summary: gapSummary(gap),
    reason: gapReason(gap),
  };
  setIfDefined(entry, "firstCursor", numberValueOrUndefined(gap.firstCursor));
  setIfDefined(entry, "lastCursor", numberValueOrUndefined(gap.lastCursor));
  return entry;
}

/** @param {Record<string, any>[]} visibleGaps */
function omissions(visibleGaps) {
  return ["Diagnostic output never includes chat text, names, credentials, raw protocol payloads, media frames, or provider-private work.", ...(visibleGaps.length > 0 ? ["Missing upstream observations are reported as visibility gaps, not success."] : [])];
}

/**
 * @param {Record<string, unknown>} brief
 */
export function formatCompactBrief(brief) {
  const lines = [
    "AgentBrief/v1",
    `Reference: ${brief.reference}`,
    ...compactFocusLines(brief),
    `Captured: ${brief.captureTime}`,
    `Environment: ${brief.environment}`,
    `Summary: ${brief.observedSummary}`,
    ...compactRunEndLines(brief),
    ...compactReleaseLines(brief),
    compactIssueLine(brief),
    ...compactGapLines(brief),
    `Resolver: ${brief.resolverCommand}`,
  ];
  return boundText(lines.join("\n"), MAX_COMPACT_CHARS);
}

/** @param {Record<string, any>} brief */
function compactFocusLines(brief) {
  if (!brief.focusedReference) return [];
  return [`Focus: ${brief.focusedReference}`];
}

/** @param {Record<string, any>} brief */
function compactRunEndLines(brief) {
  if (brief.runEndCursor === undefined) return [];
  return [`Run-end cursor: ${brief.runEndCursor}`];
}

/** @param {Record<string, any>} brief */
function compactReleaseLines(brief) {
  const releases = asArray(brief.releaseCommits);
  if (releases.length === 0) return [];
  return [`Releases: ${releases.map(releaseDescription).join(", ")}`];
}

/** @param {Record<string, any>} release */
function releaseDescription(release) {
  if (release.sourceCommit) return `${release.release} (${release.sourceCommit})`;
  return release.release;
}

/** @param {Record<string, any>} brief */
function compactIssueLine(brief) {
  return `Issues: ${countValue(brief.counts, "openIssues")} open / ${countValue(brief.counts, "issues")} total`;
}

/** @param {Record<string, any>} brief */
function compactGapLines(brief) {
  const gaps = asArray(brief.visibleGaps);
  if (gaps.length === 0) return ["Gaps: none reported"];
  return [`Gaps: ${gaps.map((gap) => `${gap.kind} (${gap.reason})`).join(", ")}`];
}

/**
 * @param {Record<string, unknown>} brief
 */
export function formatMarkdownBrief(brief) {
  const issueLines = asArray(brief.issues)
    .slice(0, 100)
    .map((issue) => `- ${stringValue(issue.severity ?? "unknown")} · ${stringValue(issue.state ?? "unknown")} · ${stringValue(issue.summary ?? "No summary")}`);
  const operationLines = asArray(brief.operations)
    .slice(0, 100)
    .map((operation) => `- ${stringValue(operation.kind ?? "operation")} · ${stringValue(operation.state ?? "unknown")} · ${stringValue(operation.id ?? "unknown")}`);
  const branchLines = asArray(brief.branches)
    .slice(0, 100)
    .map((branch) => `- ${stringValue(branch.kind ?? "branch")} · ${stringValue(branch.state ?? "unknown")} · ${stringValue(branch.id ?? "unknown")}`);
  const gapLines = asArray(brief.visibleGaps)
    .slice(0, 64)
    .map((gap) => `- ${stringValue(gap.kind)} · ${stringValue(gap.reason)} · ${stringValue(gap.summary)}`);
  const markdown = [
    "# Episode Diagnostic Agent Brief",
    "",
    ...markdownHeaderLines(brief),
    "",
    "## Summary",
    "",
    ...markdownSummaryLines(brief),
    "",
    "## Issues",
    "",
    ...markdownListLines(issueLines, "- No issues are currently reported."),
    "",
    "## Operations",
    "",
    ...markdownListLines(operationLines, "- No operation details are retained in this view."),
    "",
    "## Epilogue branches",
    "",
    ...markdownListLines(branchLines, "- No epilogue branches are registered."),
    "",
    "## Visibility gaps",
    "",
    ...markdownListLines(gapLines, "- No visibility gaps are reported."),
    "",
    "## Safe omissions",
    "",
    ...asArray(brief.omissions)
      .slice(0, 32)
      .map((item) => `- ${stringValue(item)}`),
    "",
    `Resolver command: \`${brief.resolverCommand}\``,
  ].join("\n");
  return boundText(markdown, MAX_MARKDOWN_CHARS);
}

/** @param {Record<string, any>} brief */
function markdownHeaderLines(brief) {
  return [`- Reference: \`${brief.reference}\``, ...(brief.focusedReference ? [`- Focus: \`${brief.focusedReference}\``] : []), `- Captured: ${brief.captureTime}`, `- Environment: ${brief.environment}`];
}

/** @param {Record<string, any>} brief */
function markdownSummaryLines(brief) {
  if (!brief.episodeSummary) return [brief.observedSummary];
  return [brief.observedSummary, "", brief.episodeSummary];
}

/** @param {string[]} lines @param {string} fallback */
function markdownListLines(lines, fallback) {
  if (lines.length > 0) return lines;
  return [fallback];
}

/**
 * @param {Record<string, unknown>} value
 */
export function briefResponse(value) {
  const brief = /** @type {Record<string, unknown>} */ (sanitizeDiagnosticData(value));
  return { schemaVersion: "AgentBriefResponse/v1", format: "markdown", brief, markdown: formatMarkdownBrief(brief) };
}

/** @param {unknown} value */
function asArray(value) {
  return Array.isArray(value) ? value.filter((item) => item && typeof item === "object") : [];
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" && value.length > 0 ? value : "unknown";
}

/** @param {unknown} value @param {number} fallback */
function numberValue(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** @param {unknown} value */
function numberValueOrUndefined(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** @param {Record<string, any>} target @param {string} key @param {unknown} value */
function setIfDefined(target, key, value) {
  if (value !== undefined) target[key] = value;
}

/** @param {{ reference: import("./reference.mjs").DiagnosticReference }} options @param {string} reference */
function focusedReference(options, reference) {
  return options.reference.focus ? reference : undefined;
}

/** @param {Record<string, any>} snapshot */
function captureTime(snapshot) {
  return stringValue(snapshot.capturedAt ?? new Date(0).toISOString());
}

/** @param {{ cursor?: number }} options @param {Record<string, any>} snapshot */
function selectedCursor(options, snapshot) {
  return numberValueOrUndefined(options.cursor ?? snapshot.projectedCursor);
}

/** @param {Record<string, any>} snapshot */
function runEndCursor(snapshot) {
  return numberValueOrUndefined(snapshot.runEndCursor);
}

/** @param {Record<string, any>} snapshot @param {{ reference: import("./reference.mjs").DiagnosticReference }} options */
function snapshotEnvironment(snapshot, options) {
  return stringValue(snapshot.environment ?? options.reference.environment);
}

/** @param {Record<string, any>} gap */
function gapKind(gap) {
  return stringValue(gap.kind ?? "coverage");
}

/** @param {Record<string, any>} gap */
function gapSummary(gap) {
  return stringValue(gap.summary ?? "Evidence is incomplete");
}

/** @param {Record<string, any>} gap */
function gapReason(gap) {
  return stringValue(gap.reason ?? gap.unknownReason ?? "not_available");
}

/** @param {Record<string, any> | undefined} counts @param {string} key */
function countValue(counts, key) {
  return counts?.[key] ?? 0;
}

/** @param {string} word @param {number} count */
function plural(word, count) {
  return count === 1 ? word : `${word}s`;
}

/** @param {Record<string, any>} snapshot */
function episodeSummary(snapshot) {
  const run = objectValue(snapshot.run);
  if (!run) return undefined;
  const participants = numberValue(run.participantCount, 0);
  const elapsed = numberValue(run.elapsedMilliseconds, 0);
  return `Run state is ${stringValue(run.state)} with ${participants} ${plural("Participant", participants)} and ${Math.round(elapsed / 1_000)} seconds elapsed.`;
}

/** @param {unknown} value */
function objectValue(value) {
  return value && typeof value === "object" ? /** @type {Record<string, any>} */ (value) : undefined;
}

/** @param {string} text @param {number} max */
function boundText(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 80).trimEnd()}\n\n[output bounded; request a JSON page for more evidence]`;
}

export const briefLimits = Object.freeze({ MAX_COMPACT_CHARS, MAX_MARKDOWN_CHARS });
