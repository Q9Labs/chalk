#!/usr/bin/env node
// Picks which formal models a change must run, from tools/formal/manifest.json.
// .github/workflows/formal-models.yml feeds the printed JSON into its matrix.
//
//   select-models.mjs --base <ref>     changed files = git diff <ref>...HEAD
//   select-models.mjs --files <file>   changed files = one path per line
//   select-models.mjs --all            every matrix model (workflow_dispatch)
//   select-models.mjs --paths <id>     print the model's covered code paths
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadManifest, selectModels } from "./manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = loadManifest(root);

const [flag, value] = process.argv.slice(2);

if (flag === "--paths") {
  const model = manifest.models.find((candidate) => candidate.id === value);
  if (!model) {
    console.error(`select-models: no model "${value}" in tools/formal/manifest.json`);
    process.exit(2);
  }
  console.log(model.paths.join(" "));
  process.exit(0);
}

let files;
if (flag === "--all") {
  files = null;
} else if (flag === "--files" && value) {
  files = readFileSync(value, "utf8").split("\n").filter(Boolean);
} else if (flag === "--base" && value) {
  files = execFileSync("git", ["diff", "--name-only", `${value}...HEAD`], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
} else {
  console.error("Usage: select-models.mjs --all | --base <ref> | --files <file> | --paths <model-id>");
  process.exit(2);
}

const selected = (files === null ? manifest.models.filter((model) => model.ci === "matrix") : selectModels(manifest, files)).map(({ id, title, run, timeoutMinutes }) => ({ id, title, run, timeoutMinutes }));
console.log(JSON.stringify({ include: selected }));
