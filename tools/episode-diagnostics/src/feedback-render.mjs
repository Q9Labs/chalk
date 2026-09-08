// @ts-check

/** @typedef {import("./feedback-parsers.mjs").FeedbackListResponse} FeedbackListResponse */
/** @typedef {import("./feedback-parsers.mjs").FeedbackReport} FeedbackReport */
/** @typedef {import("./feedback-download.mjs").FeedbackPullResult} FeedbackPullResult */
/** @typedef {import("./feedback-open.mjs").FeedbackOpenResult} FeedbackOpenResult */

/** @param {unknown} value */
export function escapeTerminalControls(value) {
  const text = String(value ?? "");
  return [...text].map(escapeTerminalCharacter).join("");
}

/** @param {string} character */
function escapeTerminalCharacter(character) {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 10) return "\n";
  if (isTerminalControl(codePoint)) return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  return character;
}

/** @param {number} codePoint */
function isTerminalControl(codePoint) {
  return isAsciiControl(codePoint) || isC1Control(codePoint);
}

/** @param {number} codePoint */
function isAsciiControl(codePoint) {
  return codePoint === 13 || codePoint < 32;
}

/** @param {number} codePoint */
function isC1Control(codePoint) {
  return codePoint >= 127 && codePoint <= 159;
}

/** @param {unknown} value */
export function safeFeedbackJSON(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** @param {FeedbackListResponse} response @param {"text" | "json"} format */
export function renderFeedbackList(response, format = "text") {
  if (format === "json") return safeFeedbackJSON(response);
  const lines = [`Feedback reports: ${response.reports.length}`];
  lines.push(...response.reports.map((report) => `${report.id} · ${report.category} · ${report.source} · ${report.created_at}`));
  if (response.next_cursor) lines.push(`Next cursor: ${escapeTerminalControls(response.next_cursor)}`);
  return `${lines.join("\n")}\n`;
}

/** @param {FeedbackReport} report @param {"text" | "json"} format */
export function renderFeedbackShow(report, format = "text") {
  if (format === "json") return safeFeedbackJSON(report);
  const lines = [
    `Feedback report ${report.id}`,
    `Category: ${report.category}`,
    `Source: ${report.source}`,
    `Submitter: ${report.submitter_kind}`,
    `Tenant: ${report.tenant_id}`,
    `Created: ${report.created_at}`,
    `Submitted: ${report.submitted_at}`,
    `Message: ${escapeTerminalControls(report.message)}`,
    `Evidence: ${report.evidence.size} bytes · sha256 ${report.evidence.sha256} · screenshot ${report.evidence.screenshot ? "yes" : "no"}`,
  ];
  lines.push(...correlationLines(report));
  lines.push(...additionalReportLines(report));
  return `${lines.join("\n")}\n`;
}

/** @param {FeedbackReport} report @returns {string[]} */
function correlationLines(report) {
  return Object.entries(report.correlations ?? {}).map(([key, value]) => `${labelFor(key)}: ${escapeTerminalControls(value)}`);
}

/** @param {FeedbackReport} report @returns {string[]} */
function additionalReportLines(report) {
  const excluded = new Set(["schema_version", "id", "category", "source", "submitter_kind", "tenant_id", "created_at", "submitted_at", "message", "evidence", "correlations", "diagnostic_reference"]);
  return Object.entries(report)
    .filter(([key]) => !excluded.has(key))
    .map(([key, value]) => `${labelFor(key)}: ${escapeTerminalControls(value)}`);
}

/** @param {FeedbackPullResult} result */
export function renderFeedbackPull(result) {
  return `Feedback pulled to ${escapeTerminalControls(result.output)}\nFiles: ${result.files.map(escapeTerminalControls).join(", ")}\n`;
}

/** @param {FeedbackOpenResult} result */
export function renderFeedbackOpen(result) {
  if (result.launched) return `Opened ${result.kind}: ${escapeTerminalControls(result.url)}\n`;
  return [`Open ${result.kind}: ${escapeTerminalControls(result.url)}`, `Command: ${result.command.map(shellSafeArgument).join(" ")}`].join("\n") + "\n";
}

/** @param {string} value */
function labelFor(value) {
  return value.replace(/(^|_)([a-z])/gu, (_match, prefix, character) => `${prefix ? " " : ""}${character.toUpperCase()}`);
}

/** @param {unknown} value */
function shellSafeArgument(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._:@+/-]+$/u.test(text)) return text;
  return JSON.stringify(text);
}
