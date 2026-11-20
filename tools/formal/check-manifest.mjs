#!/usr/bin/env node
// fallow-ignore-file complexity -- the consistency checks branch on every registry and consumer mismatch; the Gate's references lane exercises each path, which the CRAP estimate cannot see.
// Keeps every copy of the formal-model path lists in step with
// tools/formal/manifest.json, the one place they are written down:
//
//   - .github/workflows/formal-models.yml triggers on exactly the matrix models'
//     covered paths, their directories and the shared inputs, and skips drafts.
//   - Each model's anchors name only files the manifest says the model covers.
//   - Each model's run.sh and declared skill file exist.
//
// Runs as part of the Gate's references lane. It reads the workflow by line so it
// needs no dependency install.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, pathMatches, pathPrefix, workflowTriggerPaths } from "./manifest.mjs";

/** formalManifestProblems returns every way the model registry and its consumers disagree. */
export function formalManifestProblems(root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")) {
  let manifest;
  try {
    manifest = loadManifest(root);
  } catch (error) {
    return [`tools/formal/check-manifest: ${error instanceof Error ? error.message : String(error)}`];
  }

  const problems = workflowProblems(root, manifest);
  for (const model of manifest.models) problems.push(...modelFileProblems(root, model));
  return problems;
}

// The workflow must trigger on exactly the matrix models' covered paths and
// keep every job behind the draft guard.
function workflowProblems(root, manifest) {
  const workflowFile = ".github/workflows/formal-models.yml";
  const workflowPath = path.join(root, workflowFile);
  if (!existsSync(workflowPath)) return [`${workflowFile} is missing; the manifest's matrix models have no runner`];

  const problems = [];
  const text = readFileSync(workflowPath, "utf8");
  const pullRequest = text.match(/ {2}pull_request:\n([\s\S]*?)(?:\n {2}\w|$)/u);
  const triggered = pullRequest ? [...pullRequest[1].matchAll(/^\s+-\s+(\S+)\s*$/gmu)].map((match) => match[1]) : [];
  if (triggered.length === 0) {
    problems.push(`${workflowFile}: on.pull_request.paths is missing or empty`);
  } else {
    const expected = workflowTriggerPaths(manifest);
    for (const entry of expected.filter((candidate) => !triggered.includes(candidate))) {
      problems.push(`${workflowFile}: missing trigger path ${entry}`);
    }
    for (const entry of triggered.filter((candidate) => !expected.includes(candidate))) {
      problems.push(`${workflowFile}: trigger path ${entry} is not covered by the manifest`);
    }
  }

  const draftGuard = "github.event.pull_request.draft != true";
  const jobs = text.match(/^jobs:\n([\s\S]*)$/mu)?.[1] ?? "";
  if (!jobs) problems.push(`${workflowFile}: jobs section is missing`);
  for (const [, job, body] of jobs.matchAll(/^ {2}(\w+):\n((?: {3,}.*\n| *\n)*)/gmu)) {
    if (!body.includes(draftGuard)) problems.push(`${workflowFile}: job "${job}" must carry "${draftGuard}" so drafts stay free`);
  }
  return problems;
}

// Each model's directory, run script, declared skill and anchors file must
// exist, and anchors may name only files the manifest says the model covers.
function modelFileProblems(root, model) {
  const problems = [];
  const directory = `tools/formal/${model.id}`;
  if (!existsSync(path.join(root, directory))) problems.push(`${directory}: model directory is missing`);
  const script = model.run.split(" ")[0];
  if (!existsSync(path.join(root, script))) problems.push(`${model.id}: run script ${script} does not exist`);
  if (model.skill !== undefined && !existsSync(path.join(root, model.skill))) problems.push(`${model.id}: skill ${model.skill} does not exist`);

  const anchorsFile = path.join(root, directory, "anchors");
  if (!existsSync(anchorsFile)) return problems;
  for (const [index, line] of readFileSync(anchorsFile, "utf8").split("\n").entries()) {
    if (!line || line.startsWith("#")) continue;
    const covered = line.split("\t")[1];
    if (!covered) continue;
    const inside = model.paths.some((entry) => pathMatches(entry, covered) || covered === pathPrefix(entry) || covered.startsWith(`${pathPrefix(entry)}/`));
    if (!inside) problems.push(`${directory}/anchors:${index + 1}: ${covered} is not in the model's manifest paths`);
  }
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = formalManifestProblems();
  if (problems.length > 0) {
    console.error(`${problems.length} problem(s) against tools/formal/manifest.json:\n${problems.map((problem) => `- ${problem}`).join("\n")}`);
    process.exit(1);
  }
  console.log("Formal manifest is consistent: models, triggers, anchors and skills agree.");
}
