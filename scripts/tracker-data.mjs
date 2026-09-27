import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";

export const repoRoot = path.resolve(import.meta.dirname, "..");
export const states = {
  unknown: "Unknown",
  planned: "Planned",
  in_progress: "In progress",
  blocked: "Blocked",
};
export const areas = {
  episode_core: "Spaces and Episodes",
  identity_and_tenancy: "Identity and Tenants",
  media: "Media",
  realtime_sync: "Sync",
  collaboration: "Collaboration",
  recording: "Recording",
  transcription: "Transcription",
  security_and_compliance: "Security and compliance",
  sdk_and_embedding: "SDK and embedding",
  integrations_and_webhooks: "Integrations and webhooks",
  observability_and_operations: "Operations",
  product_delivery: "Other products",
};
const priorities = {
  P0: "First",
  P1: "Next",
  P2: "Later",
  P3: "Someday",
};
const sizes = ["S", "M", "L", "XL", "Unknown"];

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
const trackerFields = ["schema_version", "principle", "sizing", "outcomes"];
const outcomeFields = ["id", "title", "area", "state", "summary", "priority", "size", "remaining", "uncertainty", "blocked_by", "theory", "code"];
const validateIdentifier = (item, ids) => {
  string(item.id, "outcome.id");
  if (!/^[a-z][a-z0-9_.-]+$/.test(item.id)) fail(item.id, "invalid ID");
  if (ids.has(item.id)) fail(item.id, "duplicate outcome ID");
  ids.add(item.id);
};

const validatePriority = (item) => {
  if (item.priority === undefined) return;
  if (!Object.hasOwn(priorities, item.priority)) fail(item.id, "priority must be P0, P1, P2 or P3");
};

const validateSize = (item) => {
  if (!sizes.includes(item.size)) fail(item.id, "size must be S, M, L, XL or Unknown");
};

const hasRequiredRemaining = ({ state }) => ["planned", "in_progress", "blocked"].includes(state);
const validateOptionalRemaining = (item) => {
  if (item.remaining !== undefined) strings(item.remaining, `${item.id}.remaining`);
};
const validateRemaining = (item) => {
  validateOptionalRemaining(item);
  if (hasRequiredRemaining(item)) strings(item.remaining, `${item.id}.remaining`);
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
const assertReferenceScheme = (reference) => {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference)) fail(reference, "URI schemes are not allowed");
};
const assertReferencePath = (reference, file) => {
  if (path.isAbsolute(file)) fail(reference, "expected a repository-relative path");
  if (file.split(/[\\/]/).includes("..")) fail(reference, "expected a repository-relative path");
  if (/[\r\n<>]/.test(reference)) fail(reference, "expected a repository-relative path");
};
const assertReferenceFile = (reference, file) => {
  if (!file) fail(reference, "expected a repository-relative path");
  assertReferenceScheme(reference);
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

const outcomeReferences = (item) => [item.theory, ...item.code].filter(Boolean);

export const readTracker = async (root = repoRoot) => {
  await checkReference(root, "tracker.yaml");
  const source = await readFile(path.join(root, "tracker.yaml"), "utf8");
  const tracker = validateTracker(load(source));
  const references = new Set(tracker.outcomes.flatMap(outcomeReferences));
  await Promise.all([...references].map((reference) => checkReference(root, reference)));
  return tracker;
};

export const groupOutcomes = ({ outcomes }) =>
  Object.entries(areas)
    .map(([area, title]) => ({ area, title, items: outcomes.filter((item) => item.area === area) }))
    .filter((group) => group.items.length);
