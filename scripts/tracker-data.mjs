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
export const priorities = {
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
const object = (value, label, fields) => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(label, "expected an object");
  }
  const unknown = Object.keys(value).filter((key) => !fields.includes(key));
  if (unknown.length) fail(label, `unknown fields: ${unknown.join(", ")}`);
};
const strings = (value, label, required = true) => {
  if (!Array.isArray(value) || (required && value.length === 0)) fail(label, "expected a list");
  value.forEach((entry, index) => {
    string(entry, `${label}[${index}]`);
  });
  if (new Set(value).size !== value.length) fail(label, "duplicate entries");
};
const date = (value, label) => {
  string(value, label);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) fail(label, "expected YYYY-MM-DD");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    fail(label, "invalid calendar date");
  }
};

export const validateTracker = (tracker) => {
  object(tracker, "tracker.yaml", ["schema_version", "principle", "sizing", "outcomes"]);
  if (tracker.schema_version !== 7) fail("schema_version", "expected 7");
  string(tracker.principle, "principle");
  string(tracker.sizing, "sizing");
  if (!Array.isArray(tracker.outcomes) || tracker.outcomes.length === 0) {
    fail("outcomes", "expected a non-empty list");
  }
  const ids = new Set();
  for (const item of tracker.outcomes) {
    object(item, "outcome", ["id", "title", "area", "state", "summary", "priority", "size", "size_reason", "remaining", "uncertainty", "blocked_by", "theory", "code", "evidence"]);
    string(item.id, "outcome.id");
    if (!/^[a-z][a-z0-9_.-]+$/.test(item.id)) fail(item.id, "invalid ID");
    if (ids.has(item.id)) fail(item.id, "duplicate outcome ID");
    ids.add(item.id);
    for (const field of ["title", "summary"]) string(item[field], `${item.id}.${field}`);
    if (!Object.hasOwn(areas, item.area)) fail(item.id, "unknown area");
    if (!Object.hasOwn(states, item.state)) fail(item.id, "unknown state");
    if (item.priority !== undefined && !Object.hasOwn(priorities, item.priority)) {
      fail(item.id, "priority must be P0, P1 or P2");
    }
    if (item.state !== "working" && item.priority === undefined) fail(item.id, "priority required");
    if (item.state === "working") {
      if (item.size !== undefined || item.size_reason !== undefined) {
        fail(item.id, "working entries have no remaining work to size");
      }
    } else {
      if (!sizes.includes(item.size)) fail(item.id, "size must be S, M, L or Unknown");
      string(item.size_reason, `${item.id}.size_reason`);
    }
    if (item.remaining !== undefined) strings(item.remaining, `${item.id}.remaining`);
    if (item.state === "planned" || item.state === "in_progress" || item.state === "blocked") {
      strings(item.remaining, `${item.id}.remaining`);
    }
    if (item.uncertainty !== undefined) string(item.uncertainty, `${item.id}.uncertainty`);
    if (item.state === "unknown") string(item.uncertainty, `${item.id}.uncertainty`);
    if (item.blocked_by !== undefined) string(item.blocked_by, `${item.id}.blocked_by`);
    if (item.state === "blocked") string(item.blocked_by, `${item.id}.blocked_by`);
    if (item.state !== "blocked" && item.blocked_by !== undefined) {
      fail(item.id, "blocked_by requires blocked state");
    }
    if (item.state === "working" && (item.remaining !== undefined || item.uncertainty !== undefined)) {
      fail(item.id, "working scope cannot have unresolved work or uncertainty");
    }
    if (item.theory !== undefined) string(item.theory, `${item.id}.theory`);
    strings(item.code, `${item.id}.code`, false);
    if (item.evidence !== undefined && (!Array.isArray(item.evidence) || !item.evidence.length)) {
      fail(item.id, "evidence must be a non-empty list");
    }
    for (const evidence of item.evidence ?? []) {
      const label = `${item.id}.evidence`;
      object(evidence, label, ["kind", "scope", "detail", "from", "artifact", "revision", "environment", "date", "result"]);
      if (!["prior_assessment", "source_review", "check", "observation"].includes(evidence.kind)) {
        fail(label, "unknown evidence kind");
      }
      for (const field of ["scope", "detail"]) {
        if (evidence[field] !== undefined) string(evidence[field], `${label}.${field}`);
      }
      if (evidence.kind === "prior_assessment") {
        strings(evidence.from, `${label}.from`);
        for (const field of ["artifact", "revision", "environment", "date", "result"]) {
          if (evidence[field] !== undefined) fail(label, "do not invent execution metadata for a prior assessment");
        }
      } else {
        string(evidence.scope, `${label}.scope`);
        string(evidence.detail, `${label}.detail`);
        if (evidence.from !== undefined) fail(label, "from is only for prior assessments");
        for (const field of ["artifact", "revision", "environment"]) string(evidence[field], `${label}.${field}`);
        date(evidence.date, `${label}.date`);
        if (!["pass", "fail", "blocked"].includes(evidence.result)) fail(label, "result must be pass, fail or blocked");
      }
    }
  }
  return tracker;
};

export const headingSlug = (heading) =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\- ]/gu, "")
    .replaceAll(" ", "-");

export const checkReference = async (root, reference) => {
  const [file, anchor, ...extra] = reference.split("#");
  if (extra.length) fail(reference, "expected at most one fragment separator");
  if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes("..") || /[\r\n<>]/.test(reference)) {
    fail(reference, "expected a repository-relative path");
  }
  const absoluteRoot = await realpath(root);
  const absolute = await realpath(path.join(absoluteRoot, file));
  if (!absolute.startsWith(`${absoluteRoot}${path.sep}`)) fail(reference, "path leaves the repository");
  if (anchor !== undefined) {
    if (!anchor || !file.endsWith(".md")) fail(reference, "anchors require Markdown headings");
    const source = await readFile(absolute, "utf8");
    const headings = [...source.matchAll(/^#{1,6} (.+)$/gm)].map((match) => headingSlug(match[1]));
    if (!headings.includes(anchor)) fail(reference, "heading does not exist");
  }
};

export const readTracker = async (root = repoRoot) => {
  await checkReference(root, "tracker.yaml");
  const source = await readFile(path.join(root, "tracker.yaml"), "utf8");
  const tracker = validateTracker(load(source));
  const references = new Set();
  for (const item of tracker.outcomes) {
    if (item.theory) references.add(item.theory);
    for (const file of item.code) references.add(file);
    for (const evidence of item.evidence ?? []) {
      if (evidence.artifact) references.add(evidence.artifact);
    }
  }
  await Promise.all([...references].map((reference) => checkReference(root, reference)));
  return tracker;
};

const sortOutcomes = (items) => items.toSorted((a, b) => (a.priority ?? "P3").localeCompare(b.priority ?? "P3") || a.area.localeCompare(b.area) || a.title.localeCompare(b.title));

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
