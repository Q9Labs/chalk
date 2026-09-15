import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";

export const repoRoot = path.resolve(import.meta.dirname, "..");
export const states = {
  unknown: "Unknown",
  planned: "Planned",
  in_progress: "In progress",
  blocked: "Blocked",
  working: "Working",
};
export const areas = {
  product_delivery: "Product Delivery",
  episode_core: "Episode Core",
  identity_and_tenancy: "Identity And Tenancy",
  media: "Media",
  realtime_sync: "Realtime Sync",
  collaboration: "Collaboration",
  recording: "Recording",
  transcription: "Transcription",
  sdk_and_embedding: "Sdk And Embedding",
  integrations_and_webhooks: "Integrations And Webhooks",
  observability_and_operations: "Observability And Operations",
  security_and_compliance: "Security And Compliance",
  deferred_product_surface: "Deferred Product Surface",
};
const priorities = {
  P0: "First",
  P1: "Next",
  P2: "Later",
};
export const sizes = ["S", "M", "L", "Unknown"];

const fail = (label, message) => {
  throw new Error(`${label}: ${message}`);
};
const string = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") fail(label, "expected non-empty text");
};
const assertObject = (value, label) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(label, "expected an object");
  }
};
const object = (value, label, fields) => {
  assertObject(value, label);
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) fail(label, `unknown fields: ${unknown.join(", ")}`);
};
const assertRequiredList = (value, label) => {
  if (value.length === 0) fail(label, "expected a list");
};
const assertUniqueList = (value, label) => {
  if (new Set(value).size !== value.length) fail(label, "duplicate entries");
};
const strings = (value, label, required = true) => {
  if (!Array.isArray(value)) fail(label, "expected a list");
  if (required) assertRequiredList(value, label);
  value.forEach((entry, index) => {
    string(entry, `${label}[${index}]`);
  });
  assertUniqueList(value, label);
};
const date = (value, label) => {
  string(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(label, "expected YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(label, "invalid calendar date");
  }
};

const trackerFields = ["schema_version", "principle", "sizing", "outcomes"];
const outcomeFields = ["id", "title", "area", "state", "summary", "priority", "size", "size_reason", "remaining", "uncertainty", "blocked_by", "theory", "code", "evidence"];
const evidenceFields = ["kind", "scope", "detail", "from", "artifact", "revision", "environment", "date", "result"];
const evidenceKinds = ["prior_assessment", "source_review", "check", "observation"];
const executionFields = ["artifact", "revision", "environment", "date", "result"];

const validateIdentifier = (item, ids) => {
  string(item.id, "outcome.id");
  if (!/^[a-z][a-z0-9_.-]+$/.test(item.id)) fail(item.id, "invalid ID");
  if (ids.has(item.id)) fail(item.id, "duplicate outcome ID");
  ids.add(item.id);
};

const validatePriority = (item) => {
  if (item.priority === undefined) {
    if (item.state !== "working") fail(item.id, "priority required");
    return;
  }
  if (!Object.hasOwn(priorities, item.priority)) fail(item.id, "priority must be P0, P1 or P2");
};

const validateWorkingSize = (item) => {
  if (item.size !== undefined || item.size_reason !== undefined) {
    fail(item.id, "working entries have no remaining work to size");
  }
};
const validateUnfinishedSize = (item) => {
  if (!sizes.includes(item.size)) fail(item.id, "size must be S, M, L or Unknown");
  string(item.size_reason, `${item.id}.size_reason`);
};
const validateSize = (item) => {
  if (item.state === "working") {
    validateWorkingSize(item);
    return;
  }
  validateUnfinishedSize(item);
};

const hasRequiredRemaining = ({ state }) => ["planned", "in_progress", "blocked"].includes(state);
const validateOptionalRemaining = (item) => {
  if (item.remaining !== undefined) strings(item.remaining, `${item.id}.remaining`);
};
const validateWorkingResolution = (item) => {
  if (item.remaining !== undefined || item.uncertainty !== undefined) {
    fail(item.id, "working scope cannot have unresolved work or uncertainty");
  }
};
const validateRemaining = (item) => {
  validateOptionalRemaining(item);
  if (hasRequiredRemaining(item)) strings(item.remaining, `${item.id}.remaining`);
  if (item.state === "working") validateWorkingResolution(item);
};

const validateOptionalString = (value, label) => {
  if (value !== undefined) string(value, label);
};
const validateRequiredStateString = (item, state, field) => {
  if (item.state === state) string(item[field], `${item.id}.${field}`);
};
const validateBlockerState = (item) => {
  if (item.blocked_by === undefined) return;
  if (item.state !== "blocked") fail(item.id, "blocked_by requires blocked state");
};
const validateUncertaintyAndBlocker = (item) => {
  validateOptionalString(item.uncertainty, `${item.id}.uncertainty`);
  validateRequiredStateString(item, "unknown", "uncertainty");
  validateOptionalString(item.blocked_by, `${item.id}.blocked_by`);
  validateRequiredStateString(item, "blocked", "blocked_by");
  validateBlockerState(item);
};

const validateEvidenceMetadata = (evidence, label) => {
  for (const field of ["scope", "detail"]) {
    if (evidence[field] !== undefined) string(evidence[field], `${label}.${field}`);
  }
};

const validatePriorAssessment = (evidence, label) => {
  strings(evidence.from, `${label}.from`);
  for (const field of executionFields) {
    if (evidence[field] !== undefined) fail(label, "do not invent execution metadata for a prior assessment");
  }
};

const validateExecutionEvidence = (evidence, label) => {
  string(evidence.scope, `${label}.scope`);
  string(evidence.detail, `${label}.detail`);
  if (evidence.from !== undefined) fail(label, "from is only for prior assessments");
  for (const field of ["artifact", "revision", "environment"]) string(evidence[field], `${label}.${field}`);
  date(evidence.date, `${label}.date`);
  if (!["pass", "fail", "blocked"].includes(evidence.result)) fail(label, "result must be pass, fail or blocked");
};

const validateEvidenceEntry = (item, evidence) => {
  const label = `${item.id}.evidence`;
  object(evidence, label, evidenceFields);
  if (!evidenceKinds.includes(evidence.kind)) fail(label, "unknown evidence kind");
  validateEvidenceMetadata(evidence, label);
  if (evidence.kind === "prior_assessment") validatePriorAssessment(evidence, label);
  else validateExecutionEvidence(evidence, label);
};
const validateEvidenceList = (item) => {
  if (!Array.isArray(item.evidence)) fail(item.id, "evidence must be a non-empty list");
  if (item.evidence.length === 0) fail(item.id, "evidence must be a non-empty list");
  item.evidence.forEach((evidence) => validateEvidenceEntry(item, evidence));
};
const validateEvidence = (item) => {
  if (item.evidence !== undefined) validateEvidenceList(item);
};

const validateOutcomeCore = (item) => {
  for (const field of ["title", "summary"]) string(item[field], `${item.id}.${field}`);
  if (!Object.hasOwn(areas, item.area)) fail(item.id, "unknown area");
  if (!Object.hasOwn(states, item.state)) fail(item.id, "unknown state");
};
const validateOutcome = (item, ids) => {
  object(item, "outcome", outcomeFields);
  validateIdentifier(item, ids);
  validateOutcomeCore(item);
  validatePriority(item);
  validateSize(item);
  validateRemaining(item);
  validateUncertaintyAndBlocker(item);
  validateOptionalString(item.theory, `${item.id}.theory`);
  strings(item.code, `${item.id}.code`, false);
  validateEvidence(item);
};

export const validateTracker = (tracker) => {
  object(tracker, "tracker.yaml", trackerFields);
  if (tracker.schema_version !== 7) fail("schema_version", "expected 7");
  string(tracker.principle, "principle");
  string(tracker.sizing, "sizing");
  if (!Array.isArray(tracker.outcomes)) fail("outcomes", "expected a non-empty list");
  assertRequiredList(tracker.outcomes, "outcomes");
  const ids = new Set();
  tracker.outcomes.forEach((item) => validateOutcome(item, ids));
  return tracker;
};

const headingSlug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .replaceAll(" ", "-");

const assertReferenceParts = (reference, extra) => {
  if (extra.length) fail(reference, "expected at most one fragment separator");
};
const assertReferencePath = (reference, file) => {
  if (path.isAbsolute(file)) fail(reference, "expected a repository-relative path");
  if (file.split(/[\\/]/).includes("..")) fail(reference, "expected a repository-relative path");
  if (/[\r\n<>]/.test(reference)) fail(reference, "expected a repository-relative path");
};
const assertReferenceFile = (reference, file) => {
  if (!file) fail(reference, "expected a repository-relative path");
  assertReferencePath(reference, file);
};
const parseReference = (reference) => {
  const [file, anchor, ...extra] = reference.split("#");
  assertReferenceParts(reference, extra);
  assertReferenceFile(reference, file);
  return { file, anchor };
};

const assertAnchor = (file, anchor, reference) => {
  if (!anchor) fail(reference, "anchors require Markdown headings");
  if (!file.endsWith(".md")) fail(reference, "anchors require Markdown headings");
};
const checkAnchor = async (absolute, file, anchor, reference) => {
  if (anchor === undefined) return;
  assertAnchor(file, anchor, reference);
  const source = await readFile(absolute, "utf8");
  const headings = [...source.matchAll(/^#{1,6} (.+)$/gm)].map((match) => headingSlug(match[1]));
  if (!headings.includes(anchor)) fail(reference, "heading does not exist");
};

export const checkReference = async (root, reference) => {
  const { file, anchor } = parseReference(reference);
  const absoluteRoot = await realpath(root);
  const absolute = await realpath(path.join(absoluteRoot, file));
  if (!absolute.startsWith(`${absoluteRoot}${path.sep}`)) fail(reference, "path leaves the repository");
  await checkAnchor(absolute, file, anchor, reference);
};

const outcomeReferences = (item) => [item.theory, ...item.code, ...(item.evidence ?? []).map((evidence) => evidence.artifact)].filter(Boolean);

export const readTracker = async (root = repoRoot) => {
  await checkReference(root, "tracker.yaml");
  const source = await readFile(path.join(root, "tracker.yaml"), "utf8");
  const tracker = validateTracker(load(source));
  const references = new Set(tracker.outcomes.flatMap(outcomeReferences));
  await Promise.all([...references].map((reference) => checkReference(root, reference)));
  return tracker;
};

const outcomePriority = (item) => item.priority ?? "P3";
const compareAreaAndTitle = (a, b) => {
  const area = a.area.localeCompare(b.area);
  if (area !== 0) return area;
  return a.title.localeCompare(b.title);
};
const compareOutcomes = (a, b) => {
  const priority = outcomePriority(a).localeCompare(outcomePriority(b));
  if (priority !== 0) return priority;
  return compareAreaAndTitle(a, b);
};
const sortOutcomes = (items) => items.toSorted(compareOutcomes);

export const groupOutcomes = ({ outcomes }) => {
  return [
    {
      title: "First",
      items: sortOutcomes(outcomes.filter((x) => x.priority === "P0" && x.state !== "working")),
    },
    {
      title: "Next and later",
      items: sortOutcomes(outcomes.filter((x) => x.priority !== "P0" && x.state !== "working" && x.state !== "unknown")),
    },
    {
      title: "Uncertain behavior",
      items: sortOutcomes(outcomes.filter((x) => x.state === "unknown" && x.priority !== "P0")),
    },
    { title: "Working", items: sortOutcomes(outcomes.filter((x) => x.state === "working")) },
  ];
};
