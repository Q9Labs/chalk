import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { load } from "js-yaml";

export const repoRoot = path.resolve(import.meta.dirname, "..");
const states = {
  unknown: "Unknown",
  planned: "Planned",
  in_progress: "In progress",
  blocked: "Blocked",
};
const areas = {
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
const object = (value, label, fields) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(label, "expected an object");
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) fail(label, `unknown fields: ${unknown.join(", ")}`);
};
const strings = (value, label, required = true) => {
  if (!Array.isArray(value)) fail(label, "expected a list");
  if (required && value.length === 0) fail(label, "expected a list");
  value.forEach((entry, index) => string(entry, `${label}[${index}]`));
  if (new Set(value).size !== value.length) fail(label, "duplicate entries");
};
const trackerFields = ["schema_version", "principle", "sizing", "outcomes", "wishlist"];
const outcomeFields = ["id", "title", "area", "state", "summary", "priority", "size", "remaining", "uncertainty", "blocked_by", "theory", "code"];

const validateOutcome = (item, ids) => {
  object(item, "outcome", outcomeFields);
  string(item.id, "outcome.id");
  if (!/^[a-z][a-z0-9_.-]+$/.test(item.id)) fail(item.id, "invalid ID");
  if (ids.has(item.id)) fail(item.id, "duplicate outcome ID");
  ids.add(item.id);
  for (const field of ["title", "summary"]) string(item[field], `${item.id}.${field}`);
  if (!Object.hasOwn(areas, item.area)) fail(item.id, "unknown area");
  if (!Object.hasOwn(states, item.state)) fail(item.id, "unknown state");
  if (item.priority !== undefined && !Object.hasOwn(priorities, item.priority)) fail(item.id, "priority must be P0, P1, P2 or P3");
  if (!sizes.includes(item.size)) fail(item.id, "size must be S, M, L, XL or Unknown");
  if (item.remaining !== undefined || ["planned", "in_progress", "blocked"].includes(item.state)) strings(item.remaining, `${item.id}.remaining`);
  if (item.uncertainty !== undefined || item.state === "unknown") string(item.uncertainty, `${item.id}.uncertainty`);
  if (item.blocked_by !== undefined || item.state === "blocked") string(item.blocked_by, `${item.id}.blocked_by`);
  if (item.blocked_by !== undefined && item.state !== "blocked") fail(item.id, "blocked_by requires blocked state");
  if (item.theory !== undefined) string(item.theory, `${item.id}.theory`);
  strings(item.code, `${item.id}.code`, false);
};

const validateTracker = (tracker) => {
  object(tracker, "tracker.yaml", trackerFields);
  if (tracker.schema_version !== 7) fail("schema_version", "expected 7");
  string(tracker.principle, "principle");
  string(tracker.sizing, "sizing");
  if (!Array.isArray(tracker.outcomes)) fail("outcomes", "expected a non-empty list");
  if (tracker.outcomes.length === 0) fail("outcomes", "expected a list");
  const ids = new Set();
  tracker.outcomes.forEach((item) => validateOutcome(item, ids));
  if (tracker.wishlist !== undefined) {
    if (!Array.isArray(tracker.wishlist)) fail("wishlist", "expected a list");
    tracker.wishlist.forEach((item) => validateOutcome(item, ids));
  }
  return tracker;
};

const headingSlug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .replaceAll(" ", "-");

const checkReference = async (root, reference) => {
  const [file, anchor, ...extra] = reference.split("#");
  if (extra.length) fail(reference, "expected at most one fragment separator");
  if (!file) fail(reference, "expected a repository-relative path");
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference)) fail(reference, "URI schemes are not allowed");
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || /[\r\n<>]/.test(reference)) fail(reference, "expected a repository-relative path");
  const absoluteRoot = await realpath(root);
  const absolute = await realpath(path.join(absoluteRoot, file));
  if (!absolute.startsWith(`${absoluteRoot}${path.sep}`)) fail(reference, "path leaves the repository");
  if (anchor === undefined) return;
  if (!anchor || !file.endsWith(".md")) fail(reference, "anchors require Markdown headings");
  const headings = [...(await readFile(absolute, "utf8")).matchAll(/^#{1,6} (.+)$/gm)].map((match) => headingSlug(match[1]));
  if (!headings.includes(anchor)) fail(reference, "heading does not exist");
};

const outcomeReferences = (item) => [item.theory, ...item.code].filter(Boolean);

export const readTracker = async (root = repoRoot) => {
  await checkReference(root, "tracker.yaml");
  const source = await readFile(path.join(root, "tracker.yaml"), "utf8");
  const tracker = validateTracker(load(source));
  const references = new Set([...tracker.outcomes, ...(tracker.wishlist ?? [])].flatMap(outcomeReferences));
  await Promise.all([...references].map((reference) => checkReference(root, reference)));
  return tracker;
};

export const groupOutcomes = ({ outcomes }) =>
  Object.entries(areas)
    .map(([area, title]) => ({ area, title, items: outcomes.filter((item) => item.area === area) }))
    .filter((group) => group.items.length);
