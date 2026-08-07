// @ts-check

const RESULT_RENDERERS = Object.freeze({
  brief: renderBrief,
  overview: renderOverview,
  page: renderPage,
  graph: renderProjection,
  flame: renderProjection,
  participants: renderProjection,
  epilogue: renderProjection,
});

const PROJECTION_RENDERERS = Object.freeze({
  graph: graphProjectionLine,
  flame: flameProjectionLine,
  participants: participantsProjectionLine,
  epilogue: epilogueProjectionLine,
});

/**
 * @param {Record<string, any>} result
 * @param {"text"|"agent"|"json"} format
 */
export function renderDiagnosticResult(result, format = "text") {
  if (format === "json") return renderJSON(result);
  const renderer = RESULT_RENDERERS[result.kind];
  if (renderer) return renderer(result);
  return renderFallback(result);
}

/** @param {Record<string, any>} result */
function renderJSON(result) {
  return `${JSON.stringify(result, null, 2)}\n`;
}

/** @param {Record<string, any>} result */
function renderFallback(result) {
  return `${JSON.stringify(result)}\n`;
}

/** @param {Record<string, any>} result */
function renderBrief(result) {
  return `${briefText(result)}\n`;
}

/** @param {Record<string, any>} result */
function briefText(result) {
  if (result.format === "compact") return result.text;
  return result.markdown;
}

/** @param {Record<string, any>} result */
function renderOverview(result) {
  const summary = recordOrEmpty(result.summary);
  const metrics = overviewMetrics(result, summary);
  const lines = [
    `Episode Diagnostic ${result.reference}`,
    `Environment: ${result.environment} · State: ${result.state}`,
    `Cursor: ${result.projectedCursor}/${result.committedCursor}`,
    `Operations: ${metrics.operations} · Issues: ${metrics.openIssues} open / ${metrics.issues} total · Events: ${metrics.events}`,
    ...focusLines(result),
    ...overviewIssueLines(result),
    ...overviewGapLines(result),
    "Follow-up: --query events|operations|graph|flame|participants|epilogue|brief",
  ];
  return `${lines.join("\n")}\n`;
}

/** @param {Record<string, any>} result @param {Record<string, any>} summary */
function overviewMetrics(result, summary) {
  return {
    operations: number(summary.operationCount, collectionLength(result.operations)),
    openIssues: number(summary.openIssueCount, 0),
    issues: number(summary.issueCount, collectionLength(result.issues)),
    events: number(summary.eventCount, 0),
  };
}

/** @param {unknown} value */
function collectionLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

/** @param {Record<string, any>} result */
function focusLines(result) {
  if (!result.focus) return [];
  return [`Focus: ${focusLabel(result.focus)}`];
}

/** @param {Record<string, any>} result */
function overviewIssueLines(result) {
  const issues = arrayValue(result.issues).slice(0, 8);
  if (issues.length === 0) return ["Issues: none reported"];
  return ["Issues:", ...issues.map((issue) => `  ${valueOrUnknown(issue.severity)} · ${valueOrUnknown(issue.state)} · ${valueOrUnknown(issue.summary, issue.id)}`)];
}

/** @param {Record<string, any>} result */
function overviewGapLines(result) {
  const gaps = arrayValue(result.gaps).slice(0, 8);
  if (gaps.length === 0) return [];
  return [`Gaps: ${gaps.map((gap) => `${valueOrUnknown(gap.kind, "coverage")} (${valueOrUnknown(gap.reason)})`).join(", ")}`];
}

/** @param {Record<string, any>} result */
function renderPage(result) {
  const page = recordOrEmpty(result.page);
  const { key, items } = pageItems(page);
  const lines = [pageHeader(page, key, items.length), ...pageItemLines(items), ...nextCursorLines(page)];
  return `${lines.join("\n")}\n`;
}

/** @param {Record<string, any>} page */
function pageItems(page) {
  if (Array.isArray(page.events)) return { key: "events", items: page.events };
  return { key: "operations", items: arrayValue(page.operations) };
}

/** @param {Record<string, any>} page @param {string} key @param {number} itemCount */
function pageHeader(page, key, itemCount) {
  return `${key} page for ${page.reference}\nCursor: ${page.projectedCursor}/${page.committedCursor} · Returned: ${itemCount} · More: ${page.hasMore ? "yes" : "no"}`;
}

/** @param {Record<string, any>[]} items */
function pageItemLines(items) {
  return items.slice(0, 100).map((item) => `- ${valueOrUnknown(item.id, item.eventId, item.cursor)} · ${valueOrUnknown(item.kind, item.name, "event")} · ${valueOrUnknown(item.state)}`);
}

/** @param {Record<string, any>} page */
function nextCursorLines(page) {
  if (page.nextCursor === undefined) return [];
  return [`Next cursor: ${page.nextCursor}`];
}

/** @param {Record<string, any>} result */
function renderProjection(result) {
  const projection = recordOrEmpty(result.projection);
  const counts = recordOrEmpty(projection.summary);
  const summaryLine = projectionLine(result.kind, projection, counts);
  const lines = [`${result.kind} projection for ${result.reference}`, summaryLine];
  return `${lines.join("\n")}\n`;
}

/** @param {string} kind @param {Record<string, any>} projection @param {Record<string, any>} counts */
function projectionLine(kind, projection, counts) {
  const renderer = PROJECTION_RENDERERS[kind] ?? epilogueProjectionLine;
  return renderer(projection, counts);
}

/** @param {Record<string, any>} projection @param {Record<string, any>} counts */
function graphProjectionLine(projection, counts) {
  return `Nodes: ${number(counts.nodeCount, arrayLength(projection.nodes))} · Edges: ${number(counts.edgeCount, arrayLength(projection.edges))} · Failed: ${number(counts.failedCount, 0)}`;
}

/** @param {Record<string, any>} projection */
function flameProjectionLine(projection) {
  return `Lanes: ${arrayLength(projection.lanes)} · Buckets: ${arrayLength(projection.buckets)}`;
}

/** @param {Record<string, any>} projection */
function participantsProjectionLine(projection) {
  return `Participants: ${participantCount(projection)}`;
}

/** @param {Record<string, any>} projection */
function epilogueProjectionLine(projection) {
  return `Branches: ${arrayLength(projection.branches)} · State: ${valueOrUnknown(projection.state)}`;
}

/** @param {unknown} value */
function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

/** @param {Record<string, any>} projection */
function participantCount(projection) {
  if (Array.isArray(projection.participants)) return projection.participants.length;
  if (Array.isArray(projection)) return projection.length;
  return 0;
}

/** @param {Record<string, any>} focus */
function focusLabel(focus) {
  return `${valueOrUnknown(focus.kind, focus.name, "item")} ${valueOrUnknown(focus.id, focus.eventId)} · ${valueOrUnknown(focus.state)}`;
}

/** @param {unknown} value @returns {Record<string, any>} */
function recordOrEmpty(value) {
  return value && typeof value === "object" ? value : {};
}

/** @param {unknown} value */
function arrayValue(value) {
  return Array.isArray(value) ? value : [];
}

/** @param {...unknown} values */
function valueOrUnknown(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return "unknown";
}

/** @param {unknown} value @param {number} fallback */
function number(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
