// fallow-ignore-file complexity -- the validators branch on every manifest field; the Gate's references lane exercises each path, which the CRAP estimate cannot see.
// Reads tools/formal/manifest.json, the one registry of Chalk's TLA+ models: which
// code paths each model covers, how CI runs it and what command checks it.
// Path entries use workflow syntax: a trailing /** means every file under the
// directory, anything else is an exact path.
import { readFileSync } from "node:fs";
import path from "node:path";

const MANIFEST_PATH = "tools/formal/manifest.json";

export function loadManifest(root) {
  const manifest = JSON.parse(readFileSync(path.join(root, MANIFEST_PATH), "utf8"));
  const problems = validateManifest(manifest);
  if (problems.length > 0) throw new Error(`${MANIFEST_PATH}: ${problems.join("; ")}`);
  return manifest;
}

function validateManifest(manifest) {
  const problems = [];
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) return ["manifest must be an object"];
  if (!Array.isArray(manifest.shared) || manifest.shared.some((entry) => typeof entry !== "string" || !entry)) {
    problems.push("shared must be a list of repository paths");
  }
  if (!Array.isArray(manifest.models) || manifest.models.length === 0) return [...problems, "models must be a non-empty list"];
  const ids = new Set();
  for (const model of manifest.models) problems.push(...modelProblems(model, ids));
  return problems;
}

function modelProblems(model, ids) {
  const where = model?.id ?? JSON.stringify(model).slice(0, 60);
  const problems = idProblems(model, ids, where);
  if (typeof model.title !== "string" || !model.title) problems.push(`${where}: title must be a non-empty string`);
  if (typeof model.run !== "string" || !model.run.startsWith(`tools/formal/${model.id}/`)) {
    problems.push(`${where}: run must start with tools/formal/${model.id}/`);
  }
  if (!Number.isInteger(model.timeoutMinutes) || model.timeoutMinutes < 1) problems.push(`${where}: timeoutMinutes must be a positive integer`);
  if (model.ci !== "matrix" && model.ci !== "gate") problems.push(`${where}: ci must be "matrix" (.github/workflows/formal-models.yml) or "gate" (the formal-sync Gate lane)`);
  if (!Array.isArray(model.paths) || model.paths.length === 0 || model.paths.some((entry) => typeof entry !== "string" || !entry)) {
    problems.push(`${where}: paths must be a non-empty list of repository paths`);
  }
  return problems;
}

function idProblems(model, ids, where) {
  const problems = [];
  if (typeof model?.id !== "string" || !/^[a-z0-9-]+$/u.test(model.id)) problems.push(`${where}: id must be lowercase words joined by -`);
  if (ids.has(model.id)) problems.push(`${where}: listed twice`);
  ids.add(model.id);
  return problems;
}

// A changed file matches a manifest path entry when it is the exact file or sits
// under a /** directory.
export function pathMatches(entry, file) {
  if (entry.endsWith("/**")) return file.startsWith(entry.slice(0, -2));
  return file === entry;
}

export function pathPrefix(entry) {
  return entry.endsWith("/**") ? entry.slice(0, -3) : entry;
}

// What a change selects for one model: the covered code, the model itself and the
// shared inputs (the manifest, the workflow and the TLC pin).
function modelTriggerPaths(manifest, model) {
  return [...model.paths, `tools/formal/${model.id}/**`, ...manifest.shared];
}

function modelMatches(manifest, model, files) {
  const triggers = modelTriggerPaths(manifest, model);
  return files.some((file) => triggers.some((entry) => pathMatches(entry, file)));
}

// The matrix models a set of changed files selects, in manifest order. A shared
// input selects every matrix model, since it is one of each model's triggers.
export function selectModels(manifest, files) {
  return manifest.models.filter((model) => model.ci === "matrix" && modelMatches(manifest, model, files));
}

// The paths the unified workflow's pull_request trigger must list: every matrix
// model's triggers, sorted and deduplicated.
export function workflowTriggerPaths(manifest) {
  const paths = new Set(manifest.shared);
  for (const model of manifest.models) {
    if (model.ci !== "matrix") continue;
    for (const entry of modelTriggerPaths(manifest, model)) paths.add(entry);
  }
  return [...paths].sort();
}
